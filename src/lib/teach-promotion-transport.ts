import { request as httpRequest } from 'node:http';
import { readPromotionResult, promotionResponseLimit } from '@/lib/teach-production-promotion';
import { teachJsonType, validationBodyLimit } from '@/lib/teach-proposal-import';

const headers = { 'Cache-Control': 'no-store' };
const allowedErrors = [400, 401, 403, 404, 405, 408, 413, 415, 429, 500, 502, 503];

/** Local fixture POST. Neither Pages nor Netty opens a denied body. */
export async function forwardPromotionConfirmation(port: number, authorization: string, length: string,
    clientSignal: AbortSignal, openBody: () => ReadableStream<Uint8Array> | null): Promise<Response> {
  const plain = (status: number) => new Response(null, { status, headers });
  if (clientSignal.aborted) return plain(408);
  const abort = new AbortController();
  const timeout = () => abort.abort();
  const timer = setTimeout(timeout, 15_000);
  clientSignal.addEventListener('abort', timeout, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: Promise<void> | undefined;
  let complete = false;
  let failure: number | undefined;
  try {
    const request = httpRequest({ hostname: '127.0.0.1', port, agent: false, method: 'POST', signal: abort.signal,
      path: '/api/v1/teach-me/production-promotion', headers: { Authorization: authorization, Expect: '100-continue',
        'Content-Type': 'application/json', 'Content-Length': length, Connection: 'close' } });
    const closed = new Promise<void>(resolve => request.once('close', resolve));
    const response = new Promise<Response>(resolve => {
      request.once('error', () => resolve(plain(failure ?? (abort.signal.aborted ? 408 : 502))));
      request.on('information', ({ statusCode, headers: interim }) => {
        if (writer || statusCode !== 100 || interim['x-teach-promotion-continue'] !== 'fixture-v1') return;
        writer = (async () => {
          if (abort.signal.aborted) return;
          reader = openBody()?.getReader();
          if (!reader) { failure = 400; abort.abort(); return; }
          // Small bounded buffer avoids socket buffering a truncated or overlong command.
          const bytes = Buffer.alloc(Number(length));
          let size = 0;
          while (true) {
            const part = await reader.read();
            if (abort.signal.aborted) return;
            if (part.done) break;
            if (part.value.byteLength > validationBodyLimit - size) { failure = 413; abort.abort(); return; }
            if (part.value.byteLength > bytes.length - size) { failure = 400; abort.abort(); return; }
            bytes.set(part.value, size); size += part.value.byteLength;
          }
          if (bytes.length !== size) { failure = 400; abort.abort(); return; }
          complete = true;
          request.end(bytes);
        })().catch(() => { abort.abort(); });
      });
      request.once('response', async upstream => {
        const status = upstream.statusCode ?? 502;
        let result = plain(502);
        try {
          if (allowedErrors.includes(status)) result = plain(status);
          else if (complete && [200, 201, 202].includes(status) && teachJsonType.test(upstream.headers['content-type'] ?? '') &&
                   !upstream.headers['content-encoding']) {
            const bytes = Buffer.alloc(promotionResponseLimit);
            let size = 0;
            for await (const part of upstream) {
              if (part.length > bytes.length - size) throw new Error('Unbounded response');
              bytes.set(part, size); size += part.length;
            }
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
            const parsed = readPromotionResult(JSON.parse(text), status, true);
            if (parsed) result = Response.json(parsed, { status, headers });
          }
        } catch { if (abort.signal.aborted) result = plain(408); }
        finally { upstream.destroy(); resolve(result); }
      });
      request.flushHeaders();
    });
    try { return await response; }
    finally {
      request.destroy();
      await reader?.cancel().catch(() => {});
      await writer;
      reader?.releaseLock();
      await closed;
    }
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener('abort', timeout);
  }
}
