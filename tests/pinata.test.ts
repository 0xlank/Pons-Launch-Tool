import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downloadTelegramFile,
  MAX_PINATA_IMAGE_BYTES,
  testPinataAuth,
  uploadImageBufferToPinata,
} from '../src/services/pinata.js';

const DUMMY_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.dummySignature';
const DUMMY_BOT_TOKEN = '123456:TEST_BOT_TOKEN_PLACEHOLDER';

// Minimal valid PNG and JPEG magic-byte buffers
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('Pinata IPFS & Telegram File Service (src/services/pinata.ts)', () => {
  describe('testPinataAuth', () => {
    it('returns ok: true on HTTP 200 and sends Bearer authorization header', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(
          JSON.stringify({ message: 'Congratulations! You are communicating with the Pinata API!' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };

      const res = await testPinataAuth(`  ${DUMMY_JWT}  `, mockFetch);
      assert.equal(res.ok, true);
      assert.match(res.message, /Congratulations/i);
      assert.equal(capturedUrl, 'https://api.pinata.cloud/data/testAuthentication');
      assert.equal(capturedInit?.method, 'GET');
      assert.deepEqual(capturedInit?.headers, { Authorization: `Bearer ${DUMMY_JWT}` });
    });

    it('returns ok: false with HTTP status details on 401 failure', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ error: { details: 'Invalid JWT token' } }), {
          status: 401,
          statusText: 'Unauthorized',
        });

      const res = await testPinataAuth(DUMMY_JWT, mockFetch);
      assert.equal(res.ok, false);
      assert.match(res.message, /HTTP 401/i);
      assert.match(res.message, /Invalid JWT token/i);
    });

    it('rejects empty JWT without invoking fetch and handles network exceptions', async () => {
      let fetchCalls = 0;
      const neverCalled: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response('ok', { status: 200 });
      };

      const emptyRes = await testPinataAuth('   ', neverCalled);
      assert.equal(emptyRes.ok, false);
      assert.equal(fetchCalls, 0);

      const failingFetch: typeof fetch = async () => {
        throw new Error('ECONNRESET');
      };
      const netErr = await testPinataAuth(DUMMY_JWT, failingFetch);
      assert.equal(netErr.ok, false);
      assert.match(netErr.message, /ECONNRESET/);
    });
  });

  describe('uploadImageBufferToPinata', () => {
    it('uploads valid PNG and JPEG buffers and constructs normalized gateway URLs', async () => {
      const requests: Array<{ url: string; method?: string; auth?: string; body?: BodyInit | null }> = [];
      const mockFetch: typeof fetch = async (input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        requests.push({
          url: String(input),
          method: init?.method,
          auth: headers?.Authorization,
          body: init?.body,
        });
        return new Response(JSON.stringify({ IpfsHash: 'QmTestCid123456789' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      // Gateway without trailing slash + PNG
      const pngRes = await uploadImageBufferToPinata(
        PNG_BYTES,
        'my logo (v1).png',
        'image/png',
        DUMMY_JWT,
        'https://gateway.pinata.cloud/ipfs',
        mockFetch,
      );
      assert.equal(pngRes.cid, 'QmTestCid123456789');
      assert.equal(pngRes.url, 'https://gateway.pinata.cloud/ipfs/QmTestCid123456789');

      // Gateway with multiple trailing slashes + JPEG
      const jpegRes = await uploadImageBufferToPinata(
        JPEG_BYTES,
        'photo.jpg',
        'IMAGE/JPEG',
        DUMMY_JWT,
        'https://custom.mypinata.cloud/ipfs///',
        mockFetch,
      );
      assert.equal(jpegRes.cid, 'QmTestCid123456789');
      assert.equal(jpegRes.url, 'https://custom.mypinata.cloud/ipfs/QmTestCid123456789');

      assert.equal(requests.length, 2);
      assert.equal(requests[0].url, 'https://api.pinata.cloud/pinning/pinFileToIPFS');
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].auth, `Bearer ${DUMMY_JWT}`);
      assert.ok(requests[0].body instanceof FormData);

      const uploadedFile = (requests[0].body as FormData).get('file');
      assert.ok(uploadedFile instanceof Blob);
      assert.equal(uploadedFile.type, 'image/png');
      assert.equal(uploadedFile.size, PNG_BYTES.byteLength);
    });

    it('rejects buffers exceeding 10 MB and empty buffers before calling fetch', async () => {
      let fetchCalls = 0;
      const mockFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      };

      const oversized = Buffer.alloc(MAX_PINATA_IMAGE_BYTES + 1);
      await assert.rejects(
        () =>
          uploadImageBufferToPinata(
            oversized,
            'huge.png',
            'image/png',
            DUMMY_JWT,
            'https://gateway.pinata.cloud/ipfs',
            mockFetch,
          ),
        /exceeds maximum allowed size of 10 MB/i,
      );

      await assert.rejects(
        () =>
          uploadImageBufferToPinata(
            Buffer.alloc(0),
            'empty.png',
            'image/png',
            DUMMY_JWT,
            'https://gateway.pinata.cloud/ipfs',
            mockFetch,
          ),
        /empty/i,
      );

      assert.equal(fetchCalls, 0);
    });

    it('rejects non-image MIME types before calling fetch', async () => {
      let fetchCalls = 0;
      const mockFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      };

      const disallowedMimes = [
        'text/html',
        'application/javascript',
        'image/svg+xml',
        'application/octet-stream',
        'text/plain',
      ];

      for (const mime of disallowedMimes) {
        await assert.rejects(
          () =>
            uploadImageBufferToPinata(
              PNG_BYTES,
              'payload.bin',
              mime,
              DUMMY_JWT,
              'https://gateway.pinata.cloud/ipfs',
              mockFetch,
            ),
          /Unsupported image MIME type/i,
          `Expected uploadImageBufferToPinata to reject MIME "${mime}"`,
        );
      }

      assert.equal(fetchCalls, 0);
    });

    it('rejects spoofed HTML/SVG payloads disguised as image/png via binary magic-byte sniffing', async () => {
      let fetchCalls = 0;
      const mockFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ IpfsHash: 'QmShouldNotUpload' }), { status: 200 });
      };

      const fakePayloads = [
        Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8'),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8'),
        Buffer.from('not-an-image-at-all', 'utf8'),
      ];

      for (const payload of fakePayloads) {
        await assert.rejects(
          () =>
            uploadImageBufferToPinata(
              payload,
              'spoofed.png',
              'image/png',
              DUMMY_JWT,
              'https://gateway.pinata.cloud/ipfs',
              mockFetch,
            ),
          /Invalid image binary content/i,
        );
      }

      assert.equal(fetchCalls, 0);
    });

    it('handles HTTP error responses, non-JSON payloads, missing IpfsHash, and missing JWT', async () => {
      const httpErrFetch: typeof fetch = async () =>
        new Response('Forbidden: scope missing', { status: 403, statusText: 'Forbidden' });
      await assert.rejects(
        () =>
          uploadImageBufferToPinata(
            PNG_BYTES,
            'logo.png',
            'image/png',
            DUMMY_JWT,
            'https://gateway.pinata.cloud/ipfs',
            httpErrFetch,
          ),
        /HTTP 403.*scope missing/i,
      );

      const nonJsonFetch: typeof fetch = async () =>
        new Response('<html>502 Bad Gateway</html>', { status: 200 });
      await assert.rejects(
        () =>
          uploadImageBufferToPinata(
            PNG_BYTES,
            'logo.png',
            'image/png',
            DUMMY_JWT,
            'https://gateway.pinata.cloud/ipfs',
            nonJsonFetch,
          ),
        /non-JSON response/i,
      );

      const missingCidFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ PinSize: 123 }), { status: 200 });
      await assert.rejects(
        () =>
          uploadImageBufferToPinata(
            PNG_BYTES,
            'logo.png',
            'image/png',
            DUMMY_JWT,
            'https://gateway.pinata.cloud/ipfs',
            missingCidFetch,
          ),
        /did not include an IpfsHash/i,
      );

      await assert.rejects(
        () =>
          uploadImageBufferToPinata(
            PNG_BYTES,
            'logo.png',
            'image/png',
            '   ',
            'https://gateway.pinata.cloud/ipfs',
            httpErrFetch,
          ),
        /Pinata JWT is not configured/i,
      );
    });
  });

  describe('downloadTelegramFile', () => {
    it('downloads valid Telegram file paths cleanly', async () => {
      let requestedUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        requestedUrl = String(input);
        return new Response(PNG_BYTES, { status: 200 });
      };

      const bytes = await downloadTelegramFile(DUMMY_BOT_TOKEN, 'photos/file_42.jpg', mockFetch);
      assert.equal(
        requestedUrl,
        `https://api.telegram.org/file/bot${DUMMY_BOT_TOKEN}/photos/file_42.jpg`,
      );
      assert.deepEqual(bytes, PNG_BYTES);
    });

    it('rejects path traversal and unsafe file paths without calling fetch', async () => {
      let fetchCalls = 0;
      const mockFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response(PNG_BYTES, { status: 200 });
      };

      const unsafePaths = [
        '',
        '   ',
        '../secret.txt',
        'photos/../../etc/passwd',
        '/etc/passwd',
        'photos\\file.jpg',
        'photos/file.jpg?download=1',
        'photos/file.jpg#fragment',
        'https://evil.example.com/logo.png',
      ];

      for (const badPath of unsafePaths) {
        await assert.rejects(
          () => downloadTelegramFile(DUMMY_BOT_TOKEN, badPath, mockFetch),
          /Invalid Telegram file path/i,
          `Expected downloadTelegramFile to reject "${badPath}"`,
        );
      }

      assert.equal(fetchCalls, 0);
    });

    it('rejects HTTP failures, empty responses, and files exceeding 10 MB', async () => {
      const errFetch: typeof fetch = async () => new Response('Not Found', { status: 404 });
      await assert.rejects(
        () => downloadTelegramFile(DUMMY_BOT_TOKEN, 'photos/missing.jpg', errFetch),
        /HTTP 404/i,
      );

      const emptyFetch: typeof fetch = async () => new Response(new Uint8Array(0), { status: 200 });
      await assert.rejects(
        () => downloadTelegramFile(DUMMY_BOT_TOKEN, 'photos/empty.jpg', emptyFetch),
        /empty/i,
      );

      const bigFetch: typeof fetch = async () =>
        new Response(new Uint8Array(MAX_PINATA_IMAGE_BYTES + 1), { status: 200 });
      await assert.rejects(
        () => downloadTelegramFile(DUMMY_BOT_TOKEN, 'photos/huge.jpg', bigFetch),
        /exceeds 10 MB/i,
      );

      const leakingErrFetch: typeof fetch = async (input) => {
        throw new Error(`network timeout requesting ${String(input)}`);
      };
      await assert.rejects(
        () => downloadTelegramFile(DUMMY_BOT_TOKEN, 'photos/test.jpg', leakingErrFetch),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message.includes(DUMMY_BOT_TOKEN), false);
          return true;
        },
      );
    });
  });
});
