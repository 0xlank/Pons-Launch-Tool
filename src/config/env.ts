import dotenv from 'dotenv';
import { z } from 'zod';
import { assertStrongEncryptionKey } from '../storage/crypto.js';
import type { EnvBootstrapDefaults } from '../types/domain.js';

export interface AppEnv {
  botToken: string;
  ownerTelegramIds: Set<number>;
  allowedTelegramIds: Set<number>;
  encryptionKey: string;
  bootstrapDefaults: EnvBootstrapDefaults;
}

function parseTelegramIdList(raw: string | undefined, fieldName: string): number[] {
  if (!raw || raw.trim() === '') {
    return [];
  }

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const ids: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error(`${fieldName} contains an invalid Telegram user ID: "${part}"`);
    }
    const parsed = Number(part);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${fieldName} contains an out-of-range Telegram user ID: "${part}"`);
    }
    ids.push(parsed);
  }
  return ids;
}

function normalizeOptionalHttpUrl(raw: string | undefined, stripTrailingSlash: boolean): string | undefined {
  if (!raw || raw.trim() === '') {
    return undefined;
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: "${trimmed}"`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`URL must use https protocol: "${trimmed}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`URL must not contain embedded credentials: "${parsed.origin}"`);
  }
  return stripTrailingSlash ? trimmed.replace(/\/+$/, '') : trimmed;
}

const rawEnvSchema = z.object({
  BOT_TOKEN: z.string().trim().min(1, 'BOT_TOKEN is required'),
  OWNER_TELEGRAM_IDS: z.string().trim().min(1, 'OWNER_TELEGRAM_IDS is required'),
  ALLOWED_TELEGRAM_IDS: z.string().optional(),
  ENCRYPTION_KEY: z
    .string()
    .trim()
    .min(16, 'ENCRYPTION_KEY must be at least 16 characters (or a 64-character hex string)'),
  RPC_URL: z.string().optional(),
  CHAIN_ID: z.string().optional(),
  CHAIN_NAME: z.string().optional(),
  EXPLORER_URL: z.string().optional(),
  PINATA_GATEWAY: z.string().optional(),
});

export function parseEnv(raw: NodeJS.ProcessEnv): AppEnv {
  const parsed = rawEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const data = parsed.data;
  const encryptionKey = assertStrongEncryptionKey(data.ENCRYPTION_KEY);
  const ownerList = parseTelegramIdList(data.OWNER_TELEGRAM_IDS, 'OWNER_TELEGRAM_IDS');
  if (ownerList.length === 0) {
    throw new Error('OWNER_TELEGRAM_IDS must contain at least one valid Telegram user ID');
  }

  const allowedList = parseTelegramIdList(data.ALLOWED_TELEGRAM_IDS, 'ALLOWED_TELEGRAM_IDS');

  let chainId: number | undefined;
  if (data.CHAIN_ID && data.CHAIN_ID.trim() !== '') {
    if (!/^\d+$/.test(data.CHAIN_ID.trim())) {
      throw new Error(`CHAIN_ID must be a positive integer, received "${data.CHAIN_ID}"`);
    }
    const n = Number(data.CHAIN_ID.trim());
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`CHAIN_ID must be a positive safe integer, received "${data.CHAIN_ID}"`);
    }
    chainId = n;
  }

  const rpcUrl = normalizeOptionalHttpUrl(data.RPC_URL, false);
  const explorerUrl = normalizeOptionalHttpUrl(data.EXPLORER_URL, true);
  const pinataGateway = normalizeOptionalHttpUrl(data.PINATA_GATEWAY, true);
  const chainName = data.CHAIN_NAME && data.CHAIN_NAME.trim() !== '' ? data.CHAIN_NAME.trim() : undefined;

  return {
    botToken: data.BOT_TOKEN,
    ownerTelegramIds: new Set<number>(ownerList),
    allowedTelegramIds: new Set<number>(allowedList),
    encryptionKey,
    bootstrapDefaults: {
      ...(rpcUrl ? { rpcUrl } : {}),
      ...(chainId !== undefined ? { chainId } : {}),
      ...(chainName ? { chainName } : {}),
      ...(explorerUrl ? { explorerUrl } : {}),
      ...(pinataGateway ? { pinataGateway } : {}),
    },
  };
}

export function loadEnv(): AppEnv {
  dotenv.config();
  return parseEnv(process.env);
}
