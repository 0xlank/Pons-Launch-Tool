const PINATA_AUTH_URL = 'https://api.pinata.cloud/data/testAuthentication';
const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const REQUEST_TIMEOUT_MS = 15_000;

export const MAX_PINATA_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_IMAGE_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export interface PinataAuthResult {
  ok: boolean;
  message: string;
}

export interface PinataUploadResult {
  cid: string;
  url: string;
}

/**
 * Inspects binary magic bytes to identify genuine PNG, JPEG, GIF, or WebP images.
 * Rejects spoofed HTML/SVG/JS payloads regardless of declared MIME type or extension.
 */
export function sniffImageMime(bytes: Buffer | Uint8Array): string | undefined {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  // GIF87a or GIF89a
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 && // 8
    (bytes[4] === 0x37 || bytes[4] === 0x39) && // 7 or 9
    bytes[5] === 0x61 // a
  ) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }

  return undefined;
}

function sanitizeImageFilename(rawName: string, sniffedMime: string): string {
  const ext = MIME_TO_EXTENSION[sniffedMime] ?? '.png';
  const baseOnly = rawName
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);

  return `${baseOnly || 'logo'}${ext}`;
}

export async function testPinataAuth(
  jwt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PinataAuthResult> {
  const cleanJwt = jwt.trim();
  if (!cleanJwt) {
    return { ok: false, message: 'Pinata JWT is empty' };
  }

  try {
    const response = await fetchImpl(PINATA_AUTH_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cleanJwt}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const bodyText = await response.text();
    let parsedMessage = bodyText;
    try {
      const json = JSON.parse(bodyText) as { message?: string; error?: { details?: string } | string };
      if (typeof json.message === 'string') {
        parsedMessage = json.message;
      } else if (typeof json.error === 'string') {
        parsedMessage = json.error;
      } else if (json.error && typeof json.error.details === 'string') {
        parsedMessage = json.error.details;
      }
    } catch {
      // Keep raw text if response is not JSON
    }

    if (!response.ok) {
      return {
        ok: false,
        message: `HTTP ${response.status}: ${(parsedMessage || response.statusText).slice(0, 300)}`,
      };
    }

    return {
      ok: true,
      message: (parsedMessage || 'Authenticated').slice(0, 300),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

export async function uploadImageBufferToPinata(
  buffer: Buffer | Uint8Array,
  filename: string,
  mimeType: string,
  jwt: string,
  gatewayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PinataUploadResult> {
  const cleanJwt = jwt.trim();
  if (!cleanJwt) {
    throw new Error('Pinata JWT is not configured');
  }

  const normalizedMime = mimeType.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    throw new Error(
      `Unsupported image MIME type "${mimeType}". Allowed: image/png, image/jpeg, image/webp, image/gif`,
    );
  }

  if (buffer.byteLength === 0) {
    throw new Error('Image buffer is empty');
  }
  if (buffer.byteLength > MAX_PINATA_IMAGE_BYTES) {
    throw new Error(
      `Image exceeds maximum allowed size of 10 MB (${buffer.byteLength} bytes)`,
    );
  }

  const sniffedMime = sniffImageMime(buffer);
  if (!sniffedMime) {
    throw new Error(
      'Invalid image binary content: file header does not match a genuine PNG, JPEG, WebP, or GIF image',
    );
  }

  const safeFilename = sanitizeImageFilename(filename, sniffedMime);
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);

  const formData = new FormData();
  formData.append('file', new Blob([copy], { type: sniffedMime }), safeFilename);

  const response = await fetchImpl(PINATA_PIN_FILE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cleanJwt}`,
    },
    body: formData,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Pinata upload failed (HTTP ${response.status}): ${(bodyText || response.statusText).slice(0, 300)}`,
    );
  }

  let parsed: { IpfsHash?: string };
  try {
    parsed = JSON.parse(bodyText) as { IpfsHash?: string };
  } catch {
    throw new Error('Pinata returned a non-JSON response');
  }

  const cid = parsed.IpfsHash?.trim();
  if (!cid) {
    throw new Error('Pinata response did not include an IpfsHash');
  }

  const normalizedGateway = gatewayUrl.trim().replace(/\/+$/, '');
  return {
    cid,
    url: `${normalizedGateway}/${cid}`,
  };
}

export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const cleanPath = filePath.trim();
  if (
    !cleanPath ||
    cleanPath.startsWith('/') ||
    cleanPath.includes('..') ||
    cleanPath.includes('\\') ||
    cleanPath.includes('?') ||
    cleanPath.includes('#') ||
    /^[a-zA-Z]+:/.test(cleanPath)
  ) {
    throw new Error(`Invalid Telegram file path: "${filePath}"`);
  }

  const url = `https://api.telegram.org/file/bot${botToken}/${cleanPath}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = rawMsg
      .replaceAll(botToken, '***')
      .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot***');
    throw new Error(`Failed to download Telegram file: ${sanitized}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file (HTTP ${response.status})`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PINATA_IMAGE_BYTES) {
      throw new Error('Downloaded Telegram file exceeds 10 MB limit');
    }
  }

  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_PINATA_IMAGE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error('Downloaded Telegram file exceeds 10 MB limit');
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (totalBytes === 0) {
      throw new Error('Downloaded Telegram file is empty');
    }

    return Buffer.concat(chunks, totalBytes);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error('Downloaded Telegram file is empty');
  }
  if (arrayBuffer.byteLength > MAX_PINATA_IMAGE_BYTES) {
    throw new Error('Downloaded Telegram file exceeds 10 MB limit');
  }

  return Buffer.from(arrayBuffer);
}
