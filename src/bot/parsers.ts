import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getAddress, isAddress, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import type { TokenDraft, TokenSocials } from '../types/domain.js';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const PK_WITH_PREFIX_REGEX = /^0x[0-9a-fA-F]{64}$/;
const PK_RAW_REGEX = /^[0-9a-fA-F]{64}$/;
const JWT_REGEX = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ETH_DECIMAL_REGEX = /^\d+(\.\d{1,18})?$/;
const MULTIPLIER_REGEX = /^\d+(\.\d{1,4})?$/;

export const TOKEN_FIELD_LIMITS = {
  name: 80,
  symbol: 32,
  logo: 512,
  description: 1000,
  social: 256,
} as const;

export function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function maskRpcUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const hasPathOrQuery =
      (parsed.pathname && parsed.pathname !== '/') || Boolean(parsed.search) || Boolean(parsed.hash);
    return hasPathOrQuery ? `${parsed.origin}/***` : parsed.origin;
  } catch {
    return '***';
  }
}

export function looksLikeSensitiveSecret(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return PK_WITH_PREFIX_REGEX.test(trimmed) || PK_RAW_REGEX.test(trimmed) || JWT_REGEX.test(trimmed);
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return undefined;
    }
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const cleaned = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const ipVersion = isIP(cleaned);

  if (ipVersion === 4) {
    const num = ipv4ToInt(cleaned);
    if (num === undefined) {
      return true;
    }
    const a = (num >>> 24) & 0xff;
    const b = (num >>> 16) & 0xff;
    const c = (num >>> 8) & 0xff;
    // 0.0.0.0/8 (this network), 10.0.0.0/8 (private), 100.64.0.0/10 (CGNAT),
    // 127.0.0.0/8 (loopback), 169.254.0.0/16 (link-local / cloud metadata),
    // 172.16.0.0/12 (private), 192.0.0.0/24, 192.168.0.0/16 (private),
    // 198.18.0.0/15 (benchmark), 224.0.0.0/4+ (multicast/reserved)
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (ipVersion === 6) {
    if (cleaned === '::' || cleaned === '::1') return true;
    if (cleaned.startsWith('::ffff:')) {
      const mapped = cleaned.slice('::ffff:'.length);
      if (isIP(mapped) === 4) {
        return isPrivateOrReservedIp(mapped);
      }
      // Hex form e.g. ::ffff:7f00:1
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const ipv4 = `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
          return isPrivateOrReservedIp(ipv4);
        }
      }
      return true;
    }
    const firstHextet = parseInt(cleaned.split(':')[0] || '0', 16);
    // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    return false;
  }

  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!lower) {
    return true;
  }
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.home.arpa') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }
  // Reject integer/octal/hex IP encodings like http://2130706433 or 0x7f000001
  if (/^(0x[0-9a-f]+|\d+)$/i.test(lower)) {
    return true;
  }
  if (isIP(lower) !== 0) {
    return isPrivateOrReservedIp(lower);
  }
  return false;
}

export async function assertPublicHttpsUrl(rawUrl: string): Promise<ParseResult<string>> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'URL tidak valid.' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'URL wajib menggunakan protokol https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URL tidak boleh menyertakan kredensial username/password.' };
  }
  if (isBlockedHostname(url.hostname)) {
    return { ok: false, error: 'Host internal, localhost, atau IP privat diblokir demi keamanan (anti-SSRF).' };
  }

  try {
    const records = await lookup(url.hostname, { all: true });
    if (records.length === 0) {
      return { ok: false, error: 'Hostname tidak dapat di-resolve melalui DNS.' };
    }
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        return {
          ok: false,
          error: 'Domain mengarah ke alamat IP internal/privat dan diblokir demi keamanan (anti-SSRF).',
        };
      }
    }
  } catch {
    return { ok: false, error: 'Gagal memverifikasi DNS hostname URL.' };
  }

  return { ok: true, value: rawUrl };
}

export function parsePrivateKey(raw: string): ParseResult<Hex> {
  const trimmed = raw.trim();
  let normalized: string;

  if (PK_WITH_PREFIX_REGEX.test(trimmed)) {
    normalized = trimmed.toLowerCase();
  } else if (PK_RAW_REGEX.test(trimmed)) {
    normalized = `0x${trimmed.toLowerCase()}`;
  } else {
    return {
      ok: false,
      error: 'Format private key tidak valid. Harus 64 karakter hex (dengan atau tanpa awalan 0x).',
    };
  }

  const scalar = BigInt(normalized);
  if (scalar === 0n) {
    return {
      ok: false,
      error: 'Private key tidak boleh bernilai nol semua.',
    };
  }
  if (scalar >= SECP256K1_N) {
    return {
      ok: false,
      error: 'Private key berada di luar rentang kurva secp256k1 yang valid.',
    };
  }

  return { ok: true, value: normalized as Hex };
}

export function parseEvmAddress(
  raw: string,
  options?: { allowZero?: boolean },
): ParseResult<Address> {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    return {
      ok: false,
      error: 'Alamat EVM tidak valid. Pastikan format 0x diikuti 40 karakter hex.',
    };
  }

  const checksummed = getAddress(trimmed);
  if (!options?.allowZero && checksummed.toLowerCase() === zeroAddress.toLowerCase()) {
    return {
      ok: false,
      error: 'Alamat tidak boleh menggunakan zero address (0x0000...0000).',
    };
  }

  return { ok: true, value: checksummed };
}

export function parseRpcUrl(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'URL RPC tidak valid. Contoh: https://rpc.mainnet.chain.robinhood.com',
    };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'URL RPC wajib menggunakan protokol https:// demi keamanan.',
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: 'URL RPC tidak boleh menyertakan username/password di dalam URL.',
    };
  }
  if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      error: 'URL RPC tidak boleh mengarah ke localhost atau alamat IP privat/internal.',
    };
  }

  return { ok: true, value: trimmed };
}

export function parseExplorerUrl(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'URL tidak valid. Contoh: https://robin.etherscan.io',
    };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'URL wajib menggunakan protokol https://.',
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: 'URL tidak boleh menyertakan username/password di dalam URL.',
    };
  }
  if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      error: 'URL tidak boleh mengarah ke localhost atau alamat IP privat/internal.',
    };
  }

  return { ok: true, value: trimmed.replace(/\/+$/, '') };
}

export function parseLogoUrl(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') {
    return { ok: true, value: '' };
  }
  if (trimmed.length > TOKEN_FIELD_LIMITS.logo) {
    return {
      ok: false,
      error: `URL logo terlalu panjang (maksimal ${TOKEN_FIELD_LIMITS.logo} karakter).`,
    };
  }
  if (trimmed.startsWith('ipfs://')) {
    const cidPart = trimmed.slice('ipfs://'.length).trim();
    if (!cidPart || /\s/.test(cidPart)) {
      return { ok: false, error: 'Format ipfs:// tidak valid.' };
    }
    return { ok: true, value: trimmed };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'URL logo tidak valid. Gunakan https://... atau ipfs://...',
    };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'URL logo wajib menggunakan https:// atau ipfs://.',
    };
  }
  return { ok: true, value: trimmed };
}

export function parseSocialValue(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') {
    return { ok: true, value: '' };
  }
  if (trimmed.length > TOKEN_FIELD_LIMITS.social) {
    return {
      ok: false,
      error: `Link social terlalu panjang (maksimal ${TOKEN_FIELD_LIMITS.social} karakter).`,
    };
  }
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return {
      ok: false,
      error: 'Skema URL berbahaya tidak diperbolehkan pada field social.',
    };
  }
  return { ok: true, value: trimmed };
}

export function parsePositiveInt(
  raw: string,
  options?: { min?: number; max?: number; label?: string },
): ParseResult<number> {
  const trimmed = raw.trim();
  const label = options?.label ?? 'Nilai';
  const min = options?.min ?? 1;

  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `${label} harus berupa bilangan bulat positif.`,
    };
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min) {
    return {
      ok: false,
      error: `${label} minimal bernilai ${min}.`,
    };
  }

  if (options?.max !== undefined && value > options.max) {
    return {
      ok: false,
      error: `${label} maksimal bernilai ${options.max}.`,
    };
  }

  return { ok: true, value };
}

export function parseNonNegativeBigInt(
  raw: string,
  options?: { min?: bigint; max?: bigint; label?: string },
): ParseResult<bigint> {
  const trimmed = raw.trim();
  const label = options?.label ?? 'Nilai';

  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `${label} harus berupa bilangan bulat non-negatif.`,
    };
  }

  const value = BigInt(trimmed);
  if (options?.min !== undefined && value < options.min) {
    return {
      ok: false,
      error: `${label} minimal bernilai ${options.min.toString()}.`,
    };
  }
  if (options?.max !== undefined && value > options.max) {
    return {
      ok: false,
      error: `${label} maksimal bernilai ${options.max.toString()}.`,
    };
  }

  return { ok: true, value };
}

export function parseEthAmount(
  raw: string,
  options?: { allowZero?: boolean; minWei?: bigint; maxWei?: bigint },
): ParseResult<{ eth: string; wei: bigint }> {
  const trimmed = raw.trim().replace(/,/g, '.');
  if (!ETH_DECIMAL_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: 'Jumlah ETH tidak valid. Gunakan format angka desimal, contoh: 0.001',
    };
  }

  let wei: bigint;
  try {
    wei = parseEther(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Jumlah ETH tidak dapat diproses. Maksimal 18 angka desimal.',
    };
  }

  if (!options?.allowZero && wei <= 0n) {
    return {
      ok: false,
      error: 'Jumlah ETH harus lebih besar dari 0.',
    };
  }
  if (options?.minWei !== undefined && wei < options.minWei) {
    return {
      ok: false,
      error: 'Jumlah ETH terlalu kecil dari batas minimum.',
    };
  }
  if (options?.maxWei !== undefined && wei > options.maxWei) {
    return {
      ok: false,
      error: 'Jumlah ETH melebihi batas maksimum.',
    };
  }

  return { ok: true, value: { eth: trimmed, wei } };
}

export function parseBps(
  raw: string,
  options?: { min?: number; max?: number },
): ParseResult<number> {
  const min = options?.min ?? 0;
  const max = options?.max ?? 10_000;
  return parsePositiveInt(raw, { min, max, label: 'Nilai BPS' });
}

export function parseMultiplierToBps(
  raw: string,
  options?: { minBps?: number; maxBps?: number },
): ParseResult<number> {
  const cleaned = raw.trim().toLowerCase().replace(/x$/, '').replace(/,/g, '.');
  const minBps = options?.minBps ?? 10_000; // 1.0x
  const maxBps = options?.maxBps ?? 100_000; // 10.0x

  if (!MULTIPLIER_REGEX.test(cleaned)) {
    return {
      ok: false,
      error: 'Format multiplier tidak valid. Contoh: 1.5 atau 1.2 (maksimal 4 desimal).',
    };
  }

  const [wholePart, fracPart = ''] = cleaned.split('.');
  const paddedFrac = fracPart.padEnd(4, '0');
  const bpsBig = BigInt(wholePart) * 10_000n + BigInt(paddedFrac);

  if (bpsBig < BigInt(minBps) || bpsBig > BigInt(maxBps)) {
    const minStr = `${Math.floor(minBps / 10_000)}.${String(minBps % 10_000).padStart(4, '0').replace(/0+$/, '') || '0'}`;
    const maxStr = `${Math.floor(maxBps / 10_000)}.${String(maxBps % 10_000).padStart(4, '0').replace(/0+$/, '') || '0'}`;
    return {
      ok: false,
      error: `Multiplier harus berada di rentang ${minStr}x hingga ${maxStr}x.`,
    };
  }

  return { ok: true, value: Number(bpsBig) };
}

export function parseBytes32(
  raw: string,
  options?: { allowEmpty?: boolean },
): ParseResult<Hex | ''> {
  const trimmed = raw.trim();
  if (options?.allowEmpty && (trimmed === '' || trimmed === '-' || trimmed.toLowerCase() === 'auto')) {
    return { ok: true, value: '' };
  }

  if (!PK_WITH_PREFIX_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: 'Format bytes32 tidak valid. Harus diawali 0x diikuti 64 karakter hex.',
    };
  }

  return { ok: true, value: trimmed.toLowerCase() as Hex };
}

export function parseTelegramUserInput(
  raw: string,
): ParseResult<{ userId: number; label?: string }> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Masukkan Telegram User ID (angka), contoh: 123456789 Tim Ops',
    };
  }

  const match = /^(\d+)(?:\s+(.+))?$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: 'Format tidak valid. Gunakan: <TelegramUserID> [Label Opsional], contoh: 123456789 Operator',
    };
  }

  const userId = Number(match[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return {
      ok: false,
      error: 'Telegram User ID harus berupa angka positif yang valid.',
    };
  }

  const label = match[2]?.trim();
  return {
    ok: true,
    value: {
      userId,
      ...(label ? { label: label.slice(0, 64) } : {}),
    },
  };
}

export interface QuickPastePatch {
  name?: string;
  symbol?: string;
  logo?: string;
  description?: string;
  customSalt?: string;
  socials?: Partial<TokenSocials>;
  matchedFields: string[];
}

export function parseQuickPasteTemplate(raw: string): ParseResult<QuickPastePatch> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      ok: false,
      error: 'Teks kosong. Gunakan format key: value per baris (contoh: name: My Token).',
    };
  }

  const patch: QuickPastePatch = { matchedFields: [] };
  const socials: Partial<TokenSocials> = {};

  const normalizeClearable = (val: string): string => {
    const t = val.trim();
    return t === '-' || t.toLowerCase() === 'none' || t.toLowerCase() === 'clear' ? '' : t;
  };

  for (const line of lines) {
    const sepMatch = /^([a-zA-Z0-9_\-\s]+?)\s*[:=]\s*(.*)$/.exec(line);
    if (!sepMatch) {
      continue;
    }

    const rawKey = sepMatch[1].trim().toLowerCase().replace(/[\s\-_]+/g, '');
    const rawVal = sepMatch[2].trim();

    switch (rawKey) {
      case 'name':
      case 'nama':
      case 'tokenname':
        patch.name = rawVal.slice(0, TOKEN_FIELD_LIMITS.name);
        patch.matchedFields.push('name');
        break;
      case 'symbol':
      case 'ticker':
      case 'simbol':
        patch.symbol = rawVal.slice(0, TOKEN_FIELD_LIMITS.symbol);
        patch.matchedFields.push('symbol');
        break;
      case 'logo':
      case 'image':
      case 'img':
      case 'icon':
      case 'logourl': {
        const cleaned = normalizeClearable(rawVal);
        const parsedLogo = parseLogoUrl(cleaned);
        if (!parsedLogo.ok) {
          return { ok: false, error: `Baris logo tidak valid: ${parsedLogo.error}` };
        }
        patch.logo = parsedLogo.value;
        patch.matchedFields.push('logo');
        break;
      }
      case 'desc':
      case 'description':
      case 'deskripsi':
        patch.description = normalizeClearable(rawVal).slice(0, TOKEN_FIELD_LIMITS.description);
        patch.matchedFields.push('description');
        break;
      case 'twitter':
      case 'x': {
        const parsedSocial = parseSocialValue(normalizeClearable(rawVal));
        if (!parsedSocial.ok) return { ok: false, error: `Baris twitter tidak valid: ${parsedSocial.error}` };
        socials.twitter = parsedSocial.value;
        patch.matchedFields.push('twitter');
        break;
      }
      case 'telegram':
      case 'tg': {
        const parsedSocial = parseSocialValue(normalizeClearable(rawVal));
        if (!parsedSocial.ok) return { ok: false, error: `Baris telegram tidak valid: ${parsedSocial.error}` };
        socials.telegram = parsedSocial.value;
        patch.matchedFields.push('telegram');
        break;
      }
      case 'discord':
      case 'dc': {
        const parsedSocial = parseSocialValue(normalizeClearable(rawVal));
        if (!parsedSocial.ok) return { ok: false, error: `Baris discord tidak valid: ${parsedSocial.error}` };
        socials.discord = parsedSocial.value;
        patch.matchedFields.push('discord');
        break;
      }
      case 'website':
      case 'web':
      case 'site':
      case 'url': {
        const parsedSocial = parseSocialValue(normalizeClearable(rawVal));
        if (!parsedSocial.ok) return { ok: false, error: `Baris website tidak valid: ${parsedSocial.error}` };
        socials.website = parsedSocial.value;
        patch.matchedFields.push('website');
        break;
      }
      case 'github':
      case 'gh': {
        const parsedSocial = parseSocialValue(normalizeClearable(rawVal));
        if (!parsedSocial.ok) return { ok: false, error: `Baris github tidak valid: ${parsedSocial.error}` };
        socials.github = parsedSocial.value;
        patch.matchedFields.push('github');
        break;
      }
      case 'salt':
      case 'customsalt': {
        const parsedSalt = parseBytes32(rawVal, { allowEmpty: true });
        if (!parsedSalt.ok) {
          return {
            ok: false,
            error: `Baris salt tidak valid: ${parsedSalt.error}`,
          };
        }
        patch.customSalt = parsedSalt.value;
        patch.matchedFields.push('customSalt');
        break;
      }
      default:
        break;
    }
  }

  if (Object.keys(socials).length > 0) {
    patch.socials = socials;
  }

  if (patch.matchedFields.length === 0) {
    return {
      ok: false,
      error:
        'Tidak ada field yang dikenali. Gunakan format seperti:\nname: Nama Token\nsymbol: TKN\nlogo: https://...\ndesc: Deskripsi singkat\ntwitter: https://x.com/...\ngithub: https://github.com/...',
    };
  }

  return { ok: true, value: patch };
}

export function applyQuickPastePatch(draft: TokenDraft, patch: QuickPastePatch): TokenDraft {
  return {
    name: patch.name !== undefined ? patch.name : draft.name,
    symbol: patch.symbol !== undefined ? patch.symbol : draft.symbol,
    logo: patch.logo !== undefined ? patch.logo : draft.logo,
    description: patch.description !== undefined ? patch.description : draft.description,
    customSalt: patch.customSalt !== undefined ? patch.customSalt : draft.customSalt,
    socials: {
      twitter: patch.socials?.twitter !== undefined ? patch.socials.twitter : draft.socials.twitter,
      telegram:
        patch.socials?.telegram !== undefined ? patch.socials.telegram : draft.socials.telegram,
      discord: patch.socials?.discord !== undefined ? patch.socials.discord : draft.socials.discord,
      website: patch.socials?.website !== undefined ? patch.socials.website : draft.socials.website,
      github: patch.socials?.github !== undefined ? patch.socials.github : draft.socials.github,
    },
  };
}
