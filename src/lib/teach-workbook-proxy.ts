import { isQA } from '@/lib/env';
import { readWorkbookReceipt, validWorkbookFilename, workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const headers = { 'Cache-Control': 'no-store' };
const errors: Record<number, string> = { 400: 'invalid_message', 413: 'upload_too_large', 415: 'unsupported_workbook' };
let active = 0;

function error(status: number) {
  return errors[status] ? Response.json({ error: errors[status] }, { status, headers }) : new Response(null, { status, headers });
}

function filenameFromHeader(wire: string | null) {
  if (!wire || !/^[A-Za-z0-9_-]{1,340}$/.test(wire)) return null;
  try {
    const bytes = Buffer.from(wire, 'base64url');
    if (bytes.length > 255 || bytes.toString('base64url') !== wire) return null;
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return validWorkbookFilename(name) ? name : null;
  } catch { return null; }
}

async function boundedReceipt(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing receipt');
  const bytes = new Uint8Array(4096);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.length - length) throw new Error('Oversized receipt');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function forwardTeachWorkbook(request: {
  url: string;
  values: (name: string) => string[];
  body: () => ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
}) {
  if (!isQA) return error(404);
  const [authorization] = request.values('authorization');
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) return error(401);
  if (active >= 4) return error(429);
  const types = request.values('content-type');
  const [type] = types;
  const names = request.values(workbookFilenameHeader);
  const [wire] = names;
  const filename = filenameFromHeader(wire ?? null);
  if (request.url.includes('?') || types.length > 1 || type?.includes(',') || names.length !== 1 || !filename) return error(400);
  if (type?.toLowerCase() !== workbookMediaType || request.values('content-encoding').length) return error(415);
  const backend = process.env.BM_BACKEND_URL;
  if (!backend) return error(502);

  const upstream = new AbortController();
  const reader = request.body()?.getReader();
  if (!reader) return error(400);
  active++;
  let received = 0;
  let complete = false;
  let readingClient = false;
  let failure: number | undefined;
  const stop = (status: number) => {
    failure ??= status;
    upstream.abort();
    void reader.cancel().catch(() => {});
  };
  const onDisconnect = () => stop(408);
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) onDisconnect();
  const timer = setTimeout(() => stop(readingClient ? 408 : 502), 15_000);

  try {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          readingClient = true;
          const part = await reader.read();
          if (upstream.signal.aborted) { controller.error(new Error('Upload stopped')); return; }
          if (part.done) {
            if (!received) { stop(400); controller.error(new Error('Empty upload')); return; }
            complete = true;
            controller.close();
          } else if (part.value.byteLength > workbookBodyLimit - received) {
            stop(413);
            controller.error(new Error('Upload limit'));
          } else {
            received += part.value.byteLength;
            controller.enqueue(part.value);
          }
        } catch { controller.error(new Error('Upload interrupted')); }
        finally { readingClient = false; }
      },
      cancel() { void reader.cancel().catch(() => {}); },
    }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', body, duplex: 'half', signal: upstream.signal, cache: 'no-store', redirect: 'error',
      headers: { Authorization: authorization, 'Content-Type': workbookMediaType, [workbookFilenameHeader]: wire },
    };
    const response = await fetch(`${backend.replace(/\/$/, '')}/api/v1/teach-me/messages`, init);
    if (response.status !== 200 || failure || !complete) {
      void response.body?.cancel().catch(() => {});
      if (failure) return error(failure);
      return error([400, 401, 403, 404, 408, 413, 415, 429].includes(response.status) ? response.status : 502);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
      void response.body?.cancel().catch(() => {});
      return error(502);
    }
    const attachment = readWorkbookReceipt(await boundedReceipt(response), filename, received);
    return attachment && !failure ? Response.json({ attachment }, { headers }) : error(failure ?? 502);
  } catch { return error(failure ?? 502); }
  finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onDisconnect);
    upstream.abort();
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    active--;
  }
}
