import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseEnv } from '../src/config/env.js';
import { decryptSecret, deriveAesKey, encryptSecret } from '../src/storage/crypto.js';

const HEX_KEY_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HEX_KEY_A_UPPER = HEX_KEY_A.toUpperCase();
const HEX_KEY_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const PASSPHRASE_A = 'test-master-passphrase-for-pons-unit-suite';
const PASSPHRASE_B = 'different-master-passphrase-for-pons-suite';

function flipFirstHexNibble(hex: string): string {
  const first = hex[0];
  const flipped = first === '0' ? '1' : '0';
  return `${flipped}${hex.slice(1)}`;
}

describe('AES-256-GCM Secret Encryption (src/storage/crypto.ts)', () => {
  it('derives deterministic 32-byte keys from passphrases and 64-hex strings', () => {
    const kPass1 = deriveAesKey(PASSPHRASE_A);
    const kPass2 = deriveAesKey(`  ${PASSPHRASE_A}  `);
    assert.equal(kPass1.length, 32);
    assert.deepEqual(kPass1, kPass2);

    const kHexLower = deriveAesKey(HEX_KEY_A);
    const kHexUpper = deriveAesKey(HEX_KEY_A_UPPER);
    assert.equal(kHexLower.length, 32);
    assert.deepEqual(kHexLower, Buffer.from(HEX_KEY_A, 'hex'));
    assert.deepEqual(kHexLower, kHexUpper);

    assert.throws(() => deriveAesKey(''), /must not be empty/i);
    assert.throws(() => deriveAesKey('   \t\n  '), /must not be empty/i);
  });

  it('round-trips secrets with a passphrase master key across diverse UTF-8 inputs', () => {
    const samples = [
      '',
      'short',
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.signature:with:colons',
      'multiline\nsecret\r\nwith\ttabs and unicode 🚀✨Ω中',
      'x'.repeat(8192),
    ];

    for (const plaintext of samples) {
      const payload = encryptSecret(plaintext, PASSPHRASE_A);
      assert.match(payload, /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/);
      if (plaintext.length > 0) {
        assert.equal(payload.includes(plaintext), false);
      }
      assert.equal(decryptSecret(payload, PASSPHRASE_A), plaintext);
    }
  });

  it('round-trips secrets with a 64-hex 32-byte key (case-insensitive)', () => {
    const secret = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const payload = encryptSecret(secret, HEX_KEY_A);
    assert.match(payload, /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    assert.equal(decryptSecret(payload, HEX_KEY_A), secret);
    assert.equal(decryptSecret(payload, HEX_KEY_A_UPPER), secret);
  });

  it('satisfies round-trip and payload format properties across 50 random payloads', () => {
    for (let i = 0; i < 50; i += 1) {
      const byteLen = i === 0 ? 0 : (i * 17) % 512;
      const plaintext = randomBytes(byteLen).toString('base64');
      const key = i % 2 === 0 ? PASSPHRASE_A : HEX_KEY_A;

      const encrypted = encryptSecret(plaintext, key);
      const parts = encrypted.split(':');
      assert.equal(parts.length, 4);
      assert.equal(parts[0], 'v1');
      assert.equal(parts[1].length, 24);
      assert.equal(parts[2].length, 32);
      assert.equal(parts[3].length, Buffer.byteLength(plaintext, 'utf8') * 2);

      const decrypted = decryptSecret(encrypted, key);
      assert.equal(decrypted, plaintext);
    }
  });

  it('generates a unique random 96-bit IV for every encryption of identical plaintext', () => {
    const plaintext = 'identical-secret-value';
    const seenIvs = new Set<string>();
    const seenPayloads = new Set<string>();

    const iterations = 100;
    for (let i = 0; i < iterations; i += 1) {
      const payload = encryptSecret(plaintext, PASSPHRASE_A);
      const ivHex = payload.split(':')[1];
      seenIvs.add(ivHex);
      seenPayloads.add(payload);
      assert.equal(decryptSecret(payload, PASSPHRASE_A), plaintext);
    }

    assert.equal(seenIvs.size, iterations);
    assert.equal(seenPayloads.size, iterations);
  });

  it('fails decryption when given the wrong master key', () => {
    const secret = 'super-sensitive-private-key';
    const encWithPass = encryptSecret(secret, PASSPHRASE_A);
    const encWithHex = encryptSecret(secret, HEX_KEY_A);

    assert.throws(() => decryptSecret(encWithPass, PASSPHRASE_B));
    assert.throws(() => decryptSecret(encWithPass, HEX_KEY_A));
    assert.throws(() => decryptSecret(encWithHex, HEX_KEY_B));
    assert.throws(() => decryptSecret(encWithHex, PASSPHRASE_A));
  });

  it('rejects tampered IV, tampered authTag, and tampered ciphertext', () => {
    const secret = 'integrity-protected-payload-12345';
    const payload = encryptSecret(secret, HEX_KEY_A);
    const [version, ivHex, tagHex, cipherHex] = payload.split(':');

    const tamperedIv = `${version}:${flipFirstHexNibble(ivHex)}:${tagHex}:${cipherHex}`;
    assert.throws(() => decryptSecret(tamperedIv, HEX_KEY_A));

    const tamperedTag = `${version}:${ivHex}:${flipFirstHexNibble(tagHex)}:${cipherHex}`;
    assert.throws(() => decryptSecret(tamperedTag, HEX_KEY_A));

    const tamperedCipher = `${version}:${ivHex}:${tagHex}:${flipFirstHexNibble(cipherHex)}`;
    assert.throws(() => decryptSecret(tamperedCipher, HEX_KEY_A));

    const truncatedCipher = `${version}:${ivHex}:${tagHex}:${cipherHex.slice(0, -2)}`;
    assert.throws(() => decryptSecret(truncatedCipher, HEX_KEY_A));

    const appendedCipher = `${version}:${ivHex}:${tagHex}:${cipherHex}ff`;
    assert.throws(() => decryptSecret(appendedCipher, HEX_KEY_A));
  });

  it('rejects malformed payloads with clear errors', () => {
    const valid = encryptSecret('hello', HEX_KEY_A);
    const [, ivHex, tagHex, cipherHex] = valid.split(':');

    const malformedCases: Array<{ label: string; payload: string; pattern: RegExp }> = [
      { label: 'empty string', payload: '', pattern: /Invalid encrypted secret format/i },
      { label: 'too few segments', payload: `v1:${ivHex}:${tagHex}`, pattern: /Invalid encrypted secret format/i },
      { label: 'too many segments', payload: `v1:${ivHex}:${tagHex}:${cipherHex}:extra`, pattern: /Invalid encrypted secret format/i },
      { label: 'unsupported version', payload: `v2:${ivHex}:${tagHex}:${cipherHex}`, pattern: /Unsupported encrypted secret version/i },
      { label: 'short IV', payload: `v1:${ivHex.slice(0, 22)}:${tagHex}:${cipherHex}`, pattern: /Corrupted encrypted secret payload/i },
      { label: 'long IV', payload: `v1:${ivHex}00:${tagHex}:${cipherHex}`, pattern: /Corrupted encrypted secret payload/i },
      { label: 'short authTag', payload: `v1:${ivHex}:${tagHex.slice(0, 30)}:${cipherHex}`, pattern: /Corrupted encrypted secret payload/i },
      { label: 'non-hex IV', payload: `v1:${'z'.repeat(24)}:${tagHex}:${cipherHex}`, pattern: /Corrupted encrypted secret payload/i },
      { label: 'non-hex tag', payload: `v1:${ivHex}:${'g'.repeat(32)}:${cipherHex}`, pattern: /Corrupted encrypted secret payload/i },
      { label: 'odd-length ciphertext', payload: `v1:${ivHex}:${tagHex}:abc`, pattern: /Corrupted encrypted secret payload/i },
      { label: 'non-hex ciphertext', payload: `v1:${ivHex}:${tagHex}:zz`, pattern: /Corrupted encrypted secret payload/i },
    ];

    for (const tc of malformedCases) {
      assert.throws(
        () => decryptSecret(tc.payload, HEX_KEY_A),
        tc.pattern,
        `Expected rejection for malformed payload case: ${tc.label}`,
      );
    }
  });

  it('rejects all-zero, repeated-character, and placeholder encryption keys in deriveAesKey and parseEnv', () => {
    const weakKeys = [
      '0'.repeat(64),
      'a'.repeat(64),
      'ab'.repeat(32),
      'REPLACE_WITH_64_CHAR_HEX_OR_STRONG_PASSPHRASE',
      'changeme-default-secret-key',
    ];

    for (const weak of weakKeys) {
      assert.throws(() => deriveAesKey(weak), /all zeros|insufficient entropy|placeholder/i);
      assert.throws(
        () =>
          parseEnv({
            BOT_TOKEN: '123456:TEST_TOKEN',
            OWNER_TELEGRAM_IDS: '100001',
            ENCRYPTION_KEY: weak,
          }),
        /all zeros|insufficient entropy|placeholder/i,
      );
    }
  });

  it('enforces GCM AAD binding so ciphertexts cannot be transplanted across users or fields', () => {
    const secret = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const encrypted = encryptSecret(secret, HEX_KEY_A, 'v1:100001:sponsorPk');

    assert.equal(decryptSecret(encrypted, HEX_KEY_A, 'v1:100001:sponsorPk'), secret);
    // Different userId AAD must fail authentication
    assert.throws(() => decryptSecret(encrypted, HEX_KEY_A, 'v1:200002:sponsorPk'));
    // Different field AAD must fail authentication
    assert.throws(() => decryptSecret(encrypted, HEX_KEY_A, 'v1:100001:targetPk'));
    // Missing AAD must fail authentication
    assert.throws(() => decryptSecret(encrypted, HEX_KEY_A));
  });
});
