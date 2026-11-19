import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { request, type IncomingMessage, type RequestOptions } from 'node:http';
import { connect } from 'node:tls';
import { filenameFromHeader, requestBytes } from '@/lib/teach-raw-request';
import { exactTeachObject } from '@/lib/teach-clarification';
import { readImportPage, readImportReceipt, teachJsonType, validImportAttempt, validImportId } from '@/lib/teach-proposal-import';
import { validWorkbookFilename, workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

export const analogPost = '/api/prod-analog/proposal-import';
export const analogList = '/api/prod-analog/proposal-imports';
const upstreamIdentity = '/api/v1/prod-analog/fixture-identity';
const attemptHeader = 'x-teach-import-attempt';
const filenameHeader = workbookFilenameHeader.toLowerCase();
const challengeHeader = 'x-bm-analog-challenge';
const nonceHeader = 'x-bm-analog-nonce';
const admitHeader = 'x-bm-analog-admit';
const env = 'prod-analog' as const;
const incidental = ['host', 'connection', 'accept', 'accept-language', 'accept-encoding', 'user-agent',
  'authorization', 'pragma', 'cache-control', 'cookie', 'referer', 'origin', 'sec-fetch-dest', 'sec-fetch-mode',
  'sec-fetch-site', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'priority', 'dnt', 'sec-gpc'];
const plainErrors = [400, 401, 403, 404, 405, 408, 413, 415, 429, 500, 503];
const conflicts = ['unknown_supplier', 'ambiguous_supplier', 'conflicting_supplier', 'invalid_supplier_evidence',
  'no_released_skill', 'incompatible_workbook', 'attempt_mismatch'];
const hex64 = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const noStore = { 'Cache-Control': 'no-store' };
const plain = (status: number) => new Response(null, { status, headers: noStore });

type Target = Readonly<{ port: number; pin: string }>;

function pinnedTarget(capability?: Target) {
  if (!capability || !Number.isInteger(capability.port) || capability.port < 1 || capability.port > 65535 ||
      !capability.pin || capability.pin.length > 4096) return null;
  const { port, pin } = capability;
  try {
    const bytes = Buffer.from(pin, 'base64');
    if (bytes.toString('base64') !== pin) return null;
    const certificate = new X509Certificate(bytes);
    if (!certificate.raw.equals(bytes) || certificate.checkIP('127.0.0.1') !== '127.0.0.1') return null;
    return { port, certificate };
  } catch { return null; }
}
type PinnedTarget = NonNullable<ReturnType<typeof pinnedTarget>>;

/** Unregistered Pages handler: only the opted-in synthetic Node runner can mount it. No environment lookup. */
export function makeProdAnalogPages(capability?: Target) {
  const target = pinnedTarget(capability);
  let active = 0;
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const url = req.url ?? '';
    const [path] = url.split('?', 1);
    const list = path === analogList;
    const method = list ? 'GET' : 'POST';
    const headers = rawHeaders(req);
    const auth = headers.get('authorization');
    const lengths = headers.get('content-length');
    const encodings = headers.get('transfer-encoding');
    const types = headers.get('content-type');
    const filename = headers.get(filenameHeader);
    const attempt = headers.get(attemptHeader);
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : null;
    const cursor = list && query?.startsWith('cursor=') ? query.slice(7) : null;
    const allowed = new Set([...incidental, 'content-length', 'content-encoding', ...(list ? [] : ['content-type', 'transfer-encoding', filenameHeader, attemptHeader])]);
    let response: Response;
    if (!target || (!list && path !== analogPost)) response = plain(404);
    else if (req.method !== method) { res.setHeader('Allow', method); response = plain(405); }
    else if (auth.length !== 1 || auth[0].length !== 71 || !/^Bearer [0-9a-f]{64}$/.test(auth[0])) response = plain(401);
    else if (headers.names.some(name => !allowed.has(name))) response = plain(400);
    else if (list && ((query !== null && !validImportId(cursor)) || (lengths.length > 0 && (lengths.length !== 1 || lengths[0] !== '0')) ||
        headers.get('content-encoding').length)) response = plain(400);
    else if (!list && (query !== null || filename.length !== 1 || !validWorkbookFilename(filenameFromHeader(filename[0]) ?? '') ||
        attempt.length !== 1 || !validImportAttempt(attempt[0]) || types.length > 1 || types[0]?.includes(',') ||
        (lengths.length === 1 ? !validImportId(lengths[0]) || encodings.length !== 0 :
          lengths.length !== 0 || encodings.length !== 1 || encodings[0].toLowerCase() !== 'chunked'))) response = plain(400);
    else if (!list && (types[0]?.toLowerCase() !== workbookMediaType || headers.get('content-encoding').length)) response = plain(415);
    else if (!list && lengths.length && Number(lengths[0]) > workbookBodyLimit) response = plain(413);
    else if (active >= 4) response = plain(429);
    else {
      active++;
      const peer = new AbortController();
      const disconnect = () => peer.abort();
      req.on('aborted', disconnect).on('error', disconnect);
      res.on('close', disconnect);
      const timer = setTimeout(disconnect, 15_000);
      if (req.aborted || res.destroyed) disconnect();
      try {
        if (!(await preflight(target, randomBytes(16).toString('hex'), peer.signal))) response = plain(peer.signal.aborted ? 408 : 502);
        else response = await forward(target, randomBytes(16).toString('hex'), list, cursor, auth[0], filename[0], attempt[0], lengths[0], peer, () => requestBytes(req));
      } catch { response = plain(peer.signal.aborted ? 408 : 502); }
      finally {
        clearTimeout(timer);
        req.off('aborted', disconnect).off('error', disconnect);
        res.off('close', disconnect);
        active--;
      }
    }
    if (res.destroyed) return;
    if (!req.readableEnded) res.setHeader('Connection', 'close');
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(response.status).end(response.body ? await response.text() : undefined);
  };
}

function rawHeaders(req: Pick<IncomingMessage, 'rawHeaders'>) {
  const map = new Map<string, string[]>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    const values = map.get(name) ?? [];
    values.push(req.rawHeaders[i + 1].replace(/^[\t ]+|[\t ]+$/g, ''));
    map.set(name, values);
  }
  return { names: [...map.keys()], get: (name: string) => map.get(name) ?? [] };
}

/** Verify the very socket given to HTTP. No agent, reconnect, TLS resumption or platform CA fallback. */
async function requestOnPinned({ port, certificate }: PinnedTarget, signal: AbortSignal, options: RequestOptions) {
  signal.throwIfAborted();
  const socket = connect({ host: '127.0.0.1', port, ca: certificate.toString(), rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  const closed = new Promise<void>(resolve => socket.once('close', resolve));
  try {
    await Promise.race([once(socket, 'secureConnect', { signal }), closed.then(() => { throw new Error('Fixture socket closed'); })]);
    signal.throwIfAborted();
    if (!socket.authorized || !socket.getPeerCertificate().raw?.equals(certificate.raw) || socket.destroyed) throw new Error('Unverified fixture socket');
    // HTTP has no agent and can only attach to this socket. No reconnect after preflight or during the request.
    const upstream = request({ ...options, hostname: '127.0.0.1', port, createConnection: () => socket, signal });
    upstream.once('error', () => {}); // The socket may close while the caller installs its handlers.
    return { upstream, closed, destroy: () => { upstream.destroy(); socket.destroy(); } };
  } catch (error) { socket.destroy(); await closed; throw error; }
}

async function preflight(target: PinnedTarget, nonce: string, signal: AbortSignal) {
  const { upstream, closed, destroy } = await requestOnPinned(target, signal, { method: 'HEAD', path: upstreamIdentity,
    headers: { [challengeHeader]: nonce, Connection: 'close' } });
  try {
    const response = once(upstream, 'response');
    upstream.end();
    const [message] = await Promise.race([response, closed.then(() => { throw new Error('Preflight socket closed'); })]) as [IncomingMessage];
    const fields = rawHeaders(message);
    message.destroy();
    return message.statusCode === 204 && singleton(fields, nonceHeader) === nonce && singleton(fields, 'cache-control') === 'no-store';
  } finally { destroy(); await closed; }
}

const singleton = (fields: ReturnType<typeof rawHeaders>, key: string) => fields.get(key).length === 1 ? fields.get(key)[0] : undefined;

async function forward(target: PinnedTarget, nonce: string, list: boolean, cursor: string | null, authorization: string,
  filename: string | undefined, attempt: string | undefined, length: string | undefined, peer: AbortController,
  openBody: () => ReadableStream<Uint8Array>) {
  const headers: Record<string, string> = { Authorization: authorization, Connection: 'close', [challengeHeader]: nonce };
  if (!list) Object.assign(headers, { 'Content-Type': workbookMediaType, [filenameHeader]: filename, [attemptHeader]: attempt,
    Expect: '100-continue', ...(length ? { 'Content-Length': length } : { 'Transfer-Encoding': 'chunked' }) });
  const { upstream, closed, destroy } = await requestOnPinned(target, peer.signal, { method: list ? 'GET' : 'POST',
    path: (list ? '/api/v1/prod-analog/proposal-imports' : '/api/v1/prod-analog/proposal-import') + (cursor ? `?cursor=${cursor}` : ''), headers });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: Promise<void> | undefined;
  let complete = list;
  let failure: number | undefined;
  let final = false;
  const stop = (status: number) => { failure ??= status; upstream.destroy(); };
  try {
    const result = new Promise<Response>(resolve => {
      upstream.on('error', () => resolve(plain(failure ?? (peer.signal.aborted ? 408 : 502))));
      void closed.then(() => { if (!final) resolve(plain(failure ?? (peer.signal.aborted ? 408 : 502))); });
      upstream.on('information', ({ statusCode, rawHeaders: interim }) => {
        if (list || writer || final || peer.signal.aborted || statusCode !== 100 || singleton(rawHeaders({ rawHeaders: interim }), admitHeader) !== nonce) return;
        writer = (async () => {
          reader = openBody().getReader();
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (peer.signal.aborted || final || upstream.destroyed) return;
            if (part.done) break;
            size += part.value.byteLength;
            if (size > workbookBodyLimit) { stop(413); return; }
            if (length && size > Number(length)) { stop(400); return; }
            if (!upstream.write(part.value)) await once(upstream, 'drain', { signal: peer.signal });
          }
          if (!size || (length && size !== Number(length))) { stop(400); return; }
          complete = true;
          upstream.end();
        })().catch(() => { if (!final) stop(peer.signal.aborted ? 408 : 502); });
      });
      upstream.once('response', async message => {
        final = true;
        let response = plain(502);
        try {
          const meta = rawHeaders(message);
          const status = message.statusCode ?? 502;
          if (singleton(meta, nonceHeader) === nonce && singleton(meta, 'cache-control') === 'no-store') {
            if (plainErrors.includes(status)) response = plain(status);
            else if (complete && (status === 200 || (!list && (status === 201 || status === 409))) &&
                teachJsonType.test(singleton(meta, 'content-type') ?? '') && !meta.get('content-encoding').length) {
              const payload = await boundedJson(message, list ? 16 * 1024 : 4 * 1024);
              const valid = status === 409 ? exactTeachObject(payload, 'error') && conflicts.some(error => error === payload.error) :
                list ? readPage(payload, cursor) : readReceipt(payload, status);
              if (valid) response = Response.json(payload, { status, headers: noStore });
            }
          }
        } catch { if (peer.signal.aborted) response = plain(408); }
        finally { message.destroy(); resolve(response); }
      });
      if (list) upstream.end(); else upstream.flushHeaders();
    });
    return await result;
  } finally {
    // Cancel pending upstream drain and the paused inbound reader before returning the slot.
    peer.abort();
    destroy();
    await reader?.cancel().catch(() => {});
    await writer;
    reader?.releaseLock();
    await closed;
  }
}

async function boundedJson(message: IncomingMessage, limit: number): Promise<unknown> {
  const storage = Buffer.alloc(limit);
  let size = 0;
  for await (const part of message) {
    if (part.length > limit - size) throw new Error('Unbounded response');
    storage.set(part, size); size += part.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(storage.subarray(0, size)));
}

function readReceipt(payload: unknown, status: number) {
  if (!exactTeachObject(payload, 'kind', 'environment', 'importId', 'revisionId', 'generation', 'artifactSha256', 'proposalCount')) return false;
  const { environment, artifactSha256, ...rest } = payload;
  return environment === env && hex64(artifactSha256) && !!readImportReceipt(rest, status);
}

function readPage(payload: unknown, cursor: string | null) {
  if (!exactTeachObject(payload, 'kind', 'environment', 'batches', 'nextCursor') || payload.environment !== env ||
      !Array.isArray(payload.batches) || payload.batches.length > 4) return false;
  const batches = [];
  for (const batch of payload.batches) {
    if (!exactTeachObject(batch, 'importId', 'supplierKey', 'revisionId', 'generation', 'artifactSha256', 'importedAt', 'proposals')) return false;
    const { artifactSha256, ...rest } = batch;
    if (!hex64(artifactSha256)) return false;
    batches.push(rest);
  }
  return !!readImportPage({ kind: payload.kind, nextCursor: payload.nextCursor, batches }, cursor);
}
