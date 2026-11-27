import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const PAYLOAD_VERSION = 'v1';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const APP_DOMAIN_SALT = 'pons-launch-tool:aes-256-gcm:v1';
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const HEX_REGEX = /^[0-9a-fA-F]*$/;
const ALL_ZERO_REGEX = /^0+$/;
const PLACEHOLDER_KEY_REGEX = /^(replace[_-]?with|changeme|your[_-]|default[_-]?key|example)/i;
const SCRYPT_OPTIONS = {
  N: 65536,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
} as const;

const derivedKeyCache = new Map<string, Buffer>();

export function assertStrongEncryptionKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0) {
    throw new Error('Encryption key must not be empty');
  }
  if (ALL_ZERO_REGEX.test(trimmed)) {
    throw new Error('Encryption key must not be all zeros');
  }
  if (PLACEHOLDER_KEY_REGEX.test(trimmed)) {
    throw new Error('Encryption key must not use an example placeholder value');
  }
  const uniqueChars = new Set(trimmed.toLowerCase()).size;
  if (uniqueChars < 4) {
    throw new Error('Encryption key has insufficient entropy (too few unique characters)');
  }
  return trimmed;
}

export function deriveAesKey(rawKey: string): Buffer {
  const trimmed = assertStrongEncryptionKey(rawKey);
  const cacheKey = HEX_64_REGEX.test(trimmed) ? trimmed.toLowerCase() : trimmed;

  const cached = derivedKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const key = HEX_64_REGEX.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : scryptSync(trimmed, APP_DOMAIN_SALT, KEY_LENGTH_BYTES, SCRYPT_OPTIONS);

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error('Derived encryption key must be 32 bytes');
  }

  if (derivedKeyCache.size >= 32) {
    derivedKeyCache.clear();
  }
  derivedKeyCache.set(cacheKey, key);
  return key;
}

export function encryptSecret(plaintext: string, rawKey: string, aad?: string): string {
  const key = deriveAesKey(rawKey);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  if (aad !== undefined && aad.length > 0) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PAYLOAD_VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string, rawKey: string, aad?: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted secret format');
  }

  const [version, ivHex, tagHex, cipherHex] = parts;
  if (version !== PAYLOAD_VERSION) {
    throw new Error(`Unsupported encrypted secret version: "${version}"`);
  }

  if (
    ivHex.length !== IV_LENGTH_BYTES * 2 ||
    tagHex.length !== AUTH_TAG_LENGTH_BYTES * 2 ||
    !HEX_REGEX.test(ivHex) ||
    !HEX_REGEX.test(tagHex) ||
    !HEX_REGEX.test(cipherHex) ||
    cipherHex.length % 2 !== 0
  ) {
    throw new Error('Corrupted encrypted secret payload');
  }

  const key = deriveAesKey(rawKey);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  if (aad !== undefined && aad.length > 0) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
