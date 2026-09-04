// @vitest-environment node

/**
 * Tests for the price-proposal upload proxy.
 *
 * A Next route handler is just `(request) => Response`, so it can be imported
 * and called directly — no server, no HTTP client. Only the outbound `fetch` to
 * the Java backend is stubbed, which is the boundary this route exists to guard:
 * it must reject unauthenticated or non-PDF requests before they ever leave the
 * Next server, and pass everything else through faithfully.
 */

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/price-proposal/upload/route';

const BACKEND_URL = 'http://backend.test:8081';

function requestWith({
  authorization = 'Bearer test-id-token',
  body,
}: {
  authorization?: string | null;
  body: FormData;
}): NextRequest {
  const headers = new Headers();
  if (authorization !== null) headers.set('Authorization', authorization);

  return new NextRequest('http://localhost:9002/api/price-proposal/upload', {
    method: 'POST',
    headers,
    body,
  });
}

function formDataWithPdf(name = 'proposal.pdf'): FormData {
  const formData = new FormData();
  formData.append('file', new File([new Uint8Array(64)], name, { type: 'application/pdf' }), name);
  return formData;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.BM_BACKEND_URL = BACKEND_URL;
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, id: 42 }), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BM_BACKEND_URL;
});

describe('POST /api/price-proposal/upload', () => {
  describe('authorisation', () => {
    it('rejects a request with no Authorization header', async () => {
      const response = await POST(requestWith({ authorization: null, body: formDataWithPdf() }));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        success: false,
        message: 'Missing Authorization header',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a header that is not a Bearer token', async () => {
      const response = await POST(
        requestWith({ authorization: 'Basic dXNlcjpwYXNz', body: formDataWithPdf() })
      );

      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards the caller token to the backend unchanged', async () => {
      await POST(
        requestWith({ authorization: 'Bearer a-real-looking-token', body: formDataWithPdf() })
      );

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer a-real-looking-token'
      );
    });
  });

  describe('input validation', () => {
    it('rejects a request with no file part', async () => {
      const response = await POST(requestWith({ body: new FormData() }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        success: false,
        message: 'No PDF file provided.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a file part that is a plain text field', async () => {
      const body = new FormData();
      body.append('file', 'not-a-file');

      const response = await POST(requestWith({ body }));

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a non-PDF filename', async () => {
      const body = new FormData();
      body.append('file', new File(['x'], 'report.txt', { type: 'text/plain' }), 'report.txt');

      const response = await POST(requestWith({ body }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        success: false,
        message: 'Only PDF files are accepted.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts an uppercase .PDF extension', async () => {
      const response = await POST(requestWith({ body: formDataWithPdf('SCANNED.PDF') }));

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('proxying to the backend', () => {
    it('posts the file to the upload endpoint, preserving its name', async () => {
      await POST(requestWith({ body: formDataWithPdf('tarifas-2026.pdf') }));

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BACKEND_URL}/api/v1/upload-price-proposal`);
      expect(init.method).toBe('POST');

      const forwarded = (init.body as FormData).get('file') as File;
      expect(forwarded.name).toBe('tarifas-2026.pdf');
      expect(forwarded.size).toBe(64);
    });

    it('returns the backend payload and status on success', async () => {
      const response = await POST(requestWith({ body: formDataWithPdf() }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true, id: 42 });
    });

    it('passes a backend error through with its status and message', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: false, message: 'Could not extract tables' }), {
          status: 422,
        })
      );

      const response = await POST(requestWith({ body: formDataWithPdf() }));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        success: false,
        message: 'Could not extract tables',
      });
    });

    it('preserves a 401 from the backend rather than masking it as a server error', async () => {
      // The client relies on the status to tell "your token expired" apart from
      // "the extraction failed".
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invalid token' }), { status: 401 })
      );

      const response = await POST(requestWith({ body: formDataWithPdf() }));

      expect(response.status).toBe(401);
    });

    it('handles an empty backend body without throwing', async () => {
      // The handler guards `JSON.parse` behind a truthiness check on the body
      // text; without it an empty 200 would become a confusing 500.
      fetchMock.mockResolvedValue(new Response('', { status: 200 }));

      const response = await POST(requestWith({ body: formDataWithPdf() }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({});
    });

    it('reports a 500 when the backend returns malformed JSON', async () => {
      // `JSON.parse` throws inside the try block, so this lands in the catch and
      // is surfaced as a server error rather than crashing the route.
      fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 200 }));

      const response = await POST(requestWith({ body: formDataWithPdf() }));

      expect(response.status).toBe(500);
      const payload = (await response.json()) as { message: string };
      expect(payload.message).toMatch(/^Failed to upload price proposal: /);
    });

    it('reports a 500 with the cause when the backend is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const response = await POST(requestWith({ body: formDataWithPdf() }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        success: false,
        message: 'Failed to upload price proposal: connect ECONNREFUSED',
      });
    });

    it('falls back to localhost when BM_BACKEND_URL is unset', async () => {
      delete process.env.BM_BACKEND_URL;

      await POST(requestWith({ body: formDataWithPdf() }));

      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8081/api/v1/upload-price-proposal');
    });
  });
});
