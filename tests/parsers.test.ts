import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEther, zeroAddress } from 'viem';
import { escapeHtml } from '../src/bot/messages.js';
import {
  applyQuickPastePatch,
  looksLikeSensitiveSecret,
  maskRpcUrl,
  parseBps,
  parseBytes32,
  parseEthAmount,
  parseEvmAddress,
  parseExplorerUrl,
  parseLogoUrl,
  parseMultiplierToBps,
  parseNonNegativeBigInt,
  parsePositiveInt,
  parsePrivateKey,
  parseQuickPasteTemplate,
  parseRpcUrl,
  parseSocialValue,
  parseTelegramUserInput,
} from '../src/bot/parsers.js';
import { createEmptyTokenDraft } from '../src/config/defaults.js';

const SAMPLE_PK_LOWER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SAMPLE_PK_RAW_UPPER = SAMPLE_PK_LOWER.slice(2).toUpperCase();
const SAMPLE_ADDR_CHECKSUM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SAMPLE_ADDR_LOWER = SAMPLE_ADDR_CHECKSUM.toLowerCase();

describe('Input Parsers and HTML Escaping (src/bot/parsers.ts & src/bot/messages.ts)', () => {
  describe('parsePrivateKey', () => {
    it('accepts 0x-prefixed and raw 64-hex keys and normalizes to lowercase 0x-prefixed hex', () => {
      const withPrefix = parsePrivateKey(`  ${SAMPLE_PK_LOWER.toUpperCase().replace('0X', '0x')}  `);
      assert.equal(withPrefix.ok, true);
      if (withPrefix.ok) {
        assert.equal(withPrefix.value, SAMPLE_PK_LOWER);
        // Idempotence property
        const reparsed = parsePrivateKey(withPrefix.value);
        assert.deepEqual(reparsed, withPrefix);
      }

      const raw = parsePrivateKey(`  ${SAMPLE_PK_RAW_UPPER}  `);
      assert.equal(raw.ok, true);
      if (raw.ok) {
        assert.equal(raw.value, SAMPLE_PK_LOWER);
      }
    });

    it('rejects all-zero keys, keys >= secp256k1 order n, wrong lengths, and non-hex characters', () => {
      const invalidInputs = [
        '',
        '   ',
        `0x${'00'.repeat(32)}`,
        '00'.repeat(32),
        '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', // exact secp256k1 n
        `0x${'ff'.repeat(32)}`, // > secp256k1 n
        SAMPLE_PK_LOWER.slice(0, -1), // 63 hex chars
        `${SAMPLE_PK_LOWER}0`, // 65 hex chars
        `0x${'g'.repeat(64)}`,
        'not-a-private-key',
      ];

      for (const input of invalidInputs) {
        const res = parsePrivateKey(input);
        assert.equal(res.ok, false, `Expected parsePrivateKey to reject "${input}"`);
      }
    });
  });

  describe('parseEvmAddress', () => {
    it('accepts valid checksum and lowercase addresses and normalizes to EIP-55 checksum', () => {
      const fromLower = parseEvmAddress(`  ${SAMPLE_ADDR_LOWER}  `);
      assert.equal(fromLower.ok, true);
      if (fromLower.ok) {
        assert.equal(fromLower.value, SAMPLE_ADDR_CHECKSUM);
        // Idempotence property
        assert.deepEqual(parseEvmAddress(fromLower.value), fromLower);
      }

      const fromChecksum = parseEvmAddress(SAMPLE_ADDR_CHECKSUM);
      assert.equal(fromChecksum.ok, true);
      if (fromChecksum.ok) {
        assert.equal(fromChecksum.value, SAMPLE_ADDR_CHECKSUM);
      }
    });

    it('rejects zeroAddress by default and allows it only when allowZero is true', () => {
      assert.equal(parseEvmAddress(zeroAddress).ok, false);
      assert.equal(parseEvmAddress(zeroAddress, { allowZero: false }).ok, false);

      const allowed = parseEvmAddress(zeroAddress, { allowZero: true });
      assert.equal(allowed.ok, true);
      if (allowed.ok) {
        assert.equal(allowed.value, zeroAddress);
      }
    });

    it('rejects malformed addresses and invalid mixed-case checksums', () => {
      const badChecksum = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // first nibble flipped to uppercase
      const invalidInputs = [
        '',
        '0x1234',
        SAMPLE_ADDR_LOWER.slice(2), // missing 0x
        `0x${'z'.repeat(40)}`,
        badChecksum,
      ];

      for (const input of invalidInputs) {
        assert.equal(parseEvmAddress(input).ok, false, `Expected parseEvmAddress to reject "${input}"`);
      }
    });
  });

  describe('parseRpcUrl & parseExplorerUrl', () => {
    it('accepts public https URLs and rejects http, private/SSRF hosts, credentials, and unsafe schemes', () => {
      const rpcHttps = parseRpcUrl('  https://rpc.mainnet.chain.robinhood.com/v1?key=abc  ');
      assert.equal(rpcHttps.ok, true);
      if (rpcHttps.ok) {
        assert.equal(rpcHttps.value, 'https://rpc.mainnet.chain.robinhood.com/v1?key=abc');
      }

      const explorerWithSlashes = parseExplorerUrl('  https://robin.etherscan.io///  ');
      assert.equal(explorerWithSlashes.ok, true);
      if (explorerWithSlashes.ok) {
        assert.equal(explorerWithSlashes.value, 'https://robin.etherscan.io');
        // Idempotence property
        assert.deepEqual(parseExplorerUrl(explorerWithSlashes.value), explorerWithSlashes);
      }

      const rejectedUrls = [
        '',
        'not-a-url',
        'http://rpc.mainnet.chain.robinhood.com', // plaintext HTTP disallowed
        'http://127.0.0.1:8545',
        'https://127.0.0.1:8545',
        'http://169.254.169.254/latest/meta-data/',
        'https://169.254.169.254/latest/meta-data/',
        'https://[::1]:8545',
        'https://10.0.0.1/rpc',
        'https://192.168.1.10/rpc',
        'https://172.16.0.5/rpc',
        'https://localhost:8545',
        'https://user:pass@rpc.example.com',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'ftp://files.example.com/resource',
        'ws://localhost:8545',
        'wss://rpc.example.com/ws',
        'data:text/html,<script>alert(1)</script>',
      ];

      for (const bad of rejectedUrls) {
        assert.equal(parseRpcUrl(bad).ok, false, `Expected parseRpcUrl to reject "${bad}"`);
        assert.equal(parseExplorerUrl(bad).ok, false, `Expected parseExplorerUrl to reject "${bad}"`);
      }

      assert.equal(
        maskRpcUrl('https://eth-mainnet.g.alchemy.com/v2/secretApiKey123'),
        'https://eth-mainnet.g.alchemy.com/***',
      );
      assert.equal(
        maskRpcUrl('https://rpc.mainnet.chain.robinhood.com'),
        'https://rpc.mainnet.chain.robinhood.com',
      );
    });
  });

  describe('parseLogoUrl, parseSocialValue & looksLikeSensitiveSecret', () => {
    it('validates logo/social URLs and detects stray private keys or JWTs', () => {
      assert.equal(parseLogoUrl('https://gateway.pinata.cloud/ipfs/QmHash').ok, true);
      assert.equal(parseLogoUrl('ipfs://QmHash').ok, true);
      assert.equal(parseLogoUrl('-').ok, true);
      assert.equal(parseLogoUrl('javascript:alert(1)').ok, false);
      assert.equal(parseLogoUrl('data:image/svg+xml,<svg/>').ok, false);
      assert.equal(parseLogoUrl('http://insecure.example.com/logo.png').ok, false);

      assert.equal(parseSocialValue('https://x.com/test').ok, true);
      assert.equal(parseSocialValue('javascript:alert(1)').ok, false);
      assert.equal(parseSocialValue('data:text/html,boom').ok, false);

      assert.equal(looksLikeSensitiveSecret(SAMPLE_PK_LOWER), true);
      assert.equal(looksLikeSensitiveSecret(SAMPLE_PK_RAW_UPPER), true);
      assert.equal(
        looksLikeSensitiveSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
        true,
      );
      assert.equal(looksLikeSensitiveSecret('hello world'), false);
    });
  });

  describe('parseEthAmount', () => {
    it('parses decimal ETH amounts, supports comma decimals, and enforces bounds', () => {
      const standard = parseEthAmount('0.001');
      assert.equal(standard.ok, true);
      if (standard.ok) {
        assert.equal(standard.value.eth, '0.001');
        assert.equal(standard.value.wei, parseEther('0.001'));
      }

      const oneWei = parseEthAmount('0.000000000000000001');
      assert.equal(oneWei.ok, true);
      if (oneWei.ok) {
        assert.equal(oneWei.value.wei, 1n);
      }

      const commaDecimal = parseEthAmount('0,025');
      assert.equal(commaDecimal.ok, true);
      if (commaDecimal.ok) {
        assert.equal(commaDecimal.value.eth, '0.025');
        assert.equal(commaDecimal.value.wei, parseEther('0.025'));
      }

      // Zero rejected by default, allowed with allowZero
      assert.equal(parseEthAmount('0').ok, false);
      assert.equal(parseEthAmount('0.0').ok, false);
      const zeroAllowed = parseEthAmount('0', { allowZero: true });
      assert.equal(zeroAllowed.ok, true);
      if (zeroAllowed.ok) {
        assert.equal(zeroAllowed.value.wei, 0n);
      }

      // minWei / maxWei bounds
      assert.equal(parseEthAmount('0.001', { minWei: parseEther('0.01') }).ok, false);
      assert.equal(parseEthAmount('1.5', { maxWei: parseEther('1') }).ok, false);
      assert.equal(
        parseEthAmount('0.5', { minWei: parseEther('0.1'), maxWei: parseEther('1') }).ok,
        true,
      );

      // Malformed inputs
      for (const bad of ['', '-0.1', '0.0000000000000000001', '1e-4', '1,000.5', 'abc']) {
        assert.equal(parseEthAmount(bad).ok, false, `Expected parseEthAmount to reject "${bad}"`);
      }
    });
  });

  describe('parseBps & parseMultiplierToBps', () => {
    it('validates BPS boundaries 0..10000', () => {
      for (const valid of ['0', '1', '300', '10000']) {
        const res = parseBps(valid);
        assert.equal(res.ok, true, `Expected parseBps to accept "${valid}"`);
        if (res.ok) {
          assert.equal(res.value, Number(valid));
        }
      }

      for (const invalid of ['-1', '10001', '1.5', '', 'abc']) {
        assert.equal(parseBps(invalid).ok, false, `Expected parseBps to reject "${invalid}"`);
      }

      assert.equal(parseBps('50', { min: 100, max: 500 }).ok, false);
      assert.equal(parseBps('600', { min: 100, max: 500 }).ok, false);
      assert.equal(parseBps('250', { min: 100, max: 500 }).ok, true);
    });

    it('parses multipliers into basis points and rejects out-of-range values', () => {
      const cases: Array<[string, number]> = [
        ['1', 10_000],
        ['1.0', 10_000],
        ['1.5', 15_000],
        ['1.5x', 15_000],
        ['2.25X', 22_500],
        ['1,2345', 12_345],
        ['10.0x', 100_000],
      ];

      for (const [input, expected] of cases) {
        const res = parseMultiplierToBps(input);
        assert.equal(res.ok, true, `Expected parseMultiplierToBps to accept "${input}"`);
        if (res.ok) {
          assert.equal(res.value, expected);
        }
      }

      for (const bad of ['0.9999', '0.5', '10.0001', '11', '1.12345', '-1.5', 'abc', '']) {
        assert.equal(
          parseMultiplierToBps(bad).ok,
          false,
          `Expected parseMultiplierToBps to reject "${bad}"`,
        );
      }

      assert.equal(parseMultiplierToBps('1.5', { minBps: 20_000, maxBps: 50_000 }).ok, false);
      assert.equal(parseMultiplierToBps('3.0', { minBps: 20_000, maxBps: 50_000 }).ok, true);
    });
  });

  describe('parseBytes32, parsePositiveInt & parseNonNegativeBigInt', () => {
    it('validates bytes32 with and without allowEmpty', () => {
      const hex = `0x${'Ab'.repeat(32)}`;
      const parsed = parseBytes32(hex);
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.equal(parsed.value, hex.toLowerCase());
      }

      assert.equal(parseBytes32('').ok, false);
      assert.equal(parseBytes32('-').ok, false);
      assert.equal(parseBytes32('auto').ok, false);
      assert.equal(parseBytes32('ab'.repeat(32)).ok, false); // missing 0x

      for (const emptyToken of ['', '-', 'auto', 'AUTO']) {
        const res = parseBytes32(emptyToken, { allowEmpty: true });
        assert.equal(res.ok, true);
        if (res.ok) {
          assert.equal(res.value, '');
        }
      }

      assert.equal(parseBytes32('0x1234', { allowEmpty: true }).ok, false);
    });

    it('validates positive integers and non-negative bigints', () => {
      assert.equal(parsePositiveInt('42').ok, true);
      assert.equal(parsePositiveInt('0').ok, false);
      assert.equal(parsePositiveInt('-5').ok, false);
      assert.equal(parsePositiveInt('3.14').ok, false);
      assert.equal(parsePositiveInt('9007199254740992').ok, false); // MAX_SAFE_INTEGER + 1
      assert.equal(parsePositiveInt('10', { min: 5, max: 10 }).ok, true);
      assert.equal(parsePositiveInt('11', { min: 5, max: 10 }).ok, false);

      const zeroBig = parseNonNegativeBigInt('0');
      assert.equal(zeroBig.ok, true);
      if (zeroBig.ok) {
        assert.equal(zeroBig.value, 0n);
      }

      const maxUint256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      const bigRes = parseNonNegativeBigInt(maxUint256);
      assert.equal(bigRes.ok, true);
      if (bigRes.ok) {
        assert.equal(bigRes.value, BigInt(maxUint256));
      }

      assert.equal(parseNonNegativeBigInt('-1').ok, false);
      assert.equal(parseNonNegativeBigInt('1.5').ok, false);
      assert.equal(parseNonNegativeBigInt('0x10').ok, false);
      assert.equal(parseNonNegativeBigInt('100', { min: 21_000n }).ok, false);
      assert.equal(parseNonNegativeBigInt('500', { max: 400n }).ok, false);
    });
  });

  describe('parseTelegramUserInput', () => {
    it('parses ID-only and ID-with-label inputs and rejects invalid IDs', () => {
      const idOnly = parseTelegramUserInput('  123456  ');
      assert.equal(idOnly.ok, true);
      if (idOnly.ok) {
        assert.deepEqual(idOnly.value, { userId: 123456 });
      }

      const withLabel = parseTelegramUserInput('123456   Operator 1');
      assert.equal(withLabel.ok, true);
      if (withLabel.ok) {
        assert.deepEqual(withLabel.value, { userId: 123456, label: 'Operator 1' });
      }

      // Label truncated to 64 characters
      const longLabel = 'L'.repeat(100);
      const truncated = parseTelegramUserInput(`777 ${longLabel}`);
      assert.equal(truncated.ok, true);
      if (truncated.ok) {
        assert.equal(truncated.value.label?.length, 64);
      }

      for (const bad of ['', '   ', '0', '-1', '-123456', 'abc', '@handle', '99999999999999999999']) {
        assert.equal(
          parseTelegramUserInput(bad).ok,
          false,
          `Expected parseTelegramUserInput to reject "${bad}"`,
        );
      }
    });
  });

  describe('parseQuickPasteTemplate & applyQuickPastePatch', () => {
    it('parses multiline key:value templates with aliases and preserves colons in https:// URLs', () => {
      const salt = `0x${'12'.repeat(32)}`;
      const template = [
        'name: Pons Nova Token',
        'ticker: NOVA',
        'logo: https://gateway.pinata.cloud/ipfs/QmHash:v1/logo.png',
        'desc: Next-gen launch: fast & safe',
        'x: https://x.com/ponsnova',
        'tg: https://t.me/ponsnova',
        'dc: https://discord.gg/ponsnova',
        'web = https://ponsnova.example.com:8443/app',
        'gh: https://github.com/ponsnova/contracts',
        `salt: ${salt}`,
      ].join('\n');

      const parsed = parseQuickPasteTemplate(template);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      assert.equal(parsed.value.name, 'Pons Nova Token');
      assert.equal(parsed.value.symbol, 'NOVA');
      assert.equal(parsed.value.logo, 'https://gateway.pinata.cloud/ipfs/QmHash:v1/logo.png');
      assert.equal(parsed.value.description, 'Next-gen launch: fast & safe');
      assert.equal(parsed.value.socials?.twitter, 'https://x.com/ponsnova');
      assert.equal(parsed.value.socials?.telegram, 'https://t.me/ponsnova');
      assert.equal(parsed.value.socials?.discord, 'https://discord.gg/ponsnova');
      assert.equal(parsed.value.socials?.website, 'https://ponsnova.example.com:8443/app');
      assert.equal(parsed.value.socials?.github, 'https://github.com/ponsnova/contracts');
      assert.equal(parsed.value.customSalt, salt);
      assert.equal(parsed.value.matchedFields.length, 10);

      const merged = applyQuickPastePatch(createEmptyTokenDraft(), parsed.value);
      assert.equal(merged.name, 'Pons Nova Token');
      assert.equal(merged.symbol, 'NOVA');
      assert.equal(merged.socials.github, 'https://github.com/ponsnova/contracts');
      assert.equal(merged.socials.website, 'https://ponsnova.example.com:8443/app');
      assert.equal(merged.customSalt, salt);
    });

    it('clears optional fields with "-", "none", or "clear" while preserving unspecified fields', () => {
      const existing = {
        ...createEmptyTokenDraft(),
        name: 'Keep Name',
        symbol: 'KEEP',
        description: 'Old description',
        socials: {
          twitter: 'https://x.com/old',
          telegram: 'https://t.me/keep',
          discord: '',
          website: '',
          github: 'https://github.com/old',
        },
        customSalt: `0x${'ff'.repeat(32)}`,
      };

      const parsed = parseQuickPasteTemplate('desc: -\nx: none\ngh: clear\nsalt: auto');
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const merged = applyQuickPastePatch(existing, parsed.value);
      assert.equal(merged.name, 'Keep Name');
      assert.equal(merged.symbol, 'KEEP');
      assert.equal(merged.description, '');
      assert.equal(merged.socials.twitter, '');
      assert.equal(merged.socials.telegram, 'https://t.me/keep');
      assert.equal(merged.socials.github, '');
      assert.equal(merged.customSalt, '');
    });

    it('rejects empty templates, unrecognized templates, and invalid salt lines', () => {
      assert.equal(parseQuickPasteTemplate('   \n\n  ').ok, false);
      assert.equal(parseQuickPasteTemplate('unknown_field: hello').ok, false);
      assert.equal(parseQuickPasteTemplate('name: Valid\nsalt: not-a-bytes32').ok, false);
    });
  });

  describe('escapeHtml', () => {
    it('escapes <, >, &, double quotes, and single quotes', () => {
      const raw = `<script src="x.js">alert('a & b')</script>`;
      const escaped = escapeHtml(raw);
      assert.equal(
        escaped,
        '&lt;script src=&quot;x.js&quot;&gt;alert(&#39;a &amp; b&#39;)&lt;/script&gt;',
      );
    });

    it('guarantees no unescaped HTML metacharacters remain across varied inputs', () => {
      const alphabet = ['<', '>', '&', '"', "'", 'a', '1', ' ', '/', '='];
      for (let seed = 1; seed <= 40; seed += 1) {
        let sample = '';
        let x = seed * 1103515245 + 12345;
        for (let i = 0; i < 32; i += 1) {
          x = (x * 1664525 + 1013904223) >>> 0;
          sample += alphabet[x % alphabet.length];
        }

        const out = escapeHtml(sample);
        assert.equal(out.includes('<'), false);
        assert.equal(out.includes('>'), false);
        assert.equal(out.includes('"'), false);
        assert.equal(out.includes("'"), false);
        // Every '&' in output must start one of the 5 escaped entities
        const bareAmpersands = out.replace(/&(amp|lt|gt|quot|#39);/g, '');
        assert.equal(bareAmpersands.includes('&'), false);
      }
    });
  });
});
