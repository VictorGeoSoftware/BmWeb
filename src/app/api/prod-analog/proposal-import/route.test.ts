// @vitest-environment node

import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { expect, it, vi } from 'vitest';
import { analogList, analogPost, makeProdAnalogPages } from '@/testing/prod-analog-pages';
import { pricePreviewFixture } from '@/lib/teach-draft-preview.testing';
import { workbookMediaType } from '@/lib/teach-workbook';
import { syntheticLoopbackCertificate } from '@/testing/prod-analog-test-certificate';

const tls = syntheticLoopbackCertificate();
const token = 'e'.repeat(64);
const head = (actor = token, name = 'bm-pilot-gesternova.xlsx', id = 1) => ({
  Authorization: `Bearer ${actor}`, 'Content-Type': workbookMediaType,
  'X-Teach-Workbook-Filename': Buffer.from(name).toString('base64url'), 'X-Teach-Import-Attempt': id.toString(16).padStart(32, '0'),
});

function paused(headers: Record<string, string>, url = analogPost, method = 'POST', raw = Object.entries(headers).flat()) {
  const req = Object.assign(new PassThrough(), { rawHeaders: raw, method, url });
  const read = vi.spyOn(req, 'read');
  let response = '';
  const res = Object.assign(new PassThrough(), { code: 0, headers: new Headers(),
    setHeader(name: string, value: string) { this.headers.set(name, value); }, status(value: number) { this.code = value; return this; } });
  res.on('data', chunk => { response += chunk.toString(); });
  return { req, res, read, text: () => response, run: (handler: ReturnType<typeof makeProdAnalogPages>) =>
    handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse) };
}

async function listen<T>(server: Server, action: (port: number) => Promise<T>): Promise<T> {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); return await action((server.address() as AddressInfo).port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}

it('keeps the Pages handler unmounted without capability and rejects raw framing and overrides before reading', async () => {
  const headers = { ...head(), 'Content-Length': '2' };
  const target = makeProdAnalogPages({ port: 1, pin: tls.pin }); // no connection should be attempted
  for (const [status, call, handler] of [
    [404, paused(headers), makeProdAnalogPages()], [404, paused(headers, '/api/teach-me/proposal-import'), target],
    [405, paused(headers, analogPost, 'GET'), target], [401, paused(head('fixture-token')), target],
    [401, paused(headers, analogPost, 'POST', [...Object.entries(headers).flat(), 'Authorization', `Bearer ${token}`]), target],
    [400, paused({ ...headers, 'Transfer-Encoding': 'chunked' }), target], [400, paused(headers, analogPost + '?revision=A'), target],
    [400, paused({ ...headers, 'X-Teach-Artifact-Sha256': 'x' }), target], [400, paused({ ...headers, 'X-Bm-Analog-Challenge': 'x' }), target],
    [413, paused({ ...headers, 'Content-Length': '5242881' }), target], [415, paused({ ...headers, 'Content-Type': 'application/pdf' }), target],
    [400, paused({ Authorization: `Bearer ${token}` }, analogList + '?cursor=01', 'GET'), target],
    [400, paused({ Authorization: `Bearer ${token}`, 'Content-Length': '1' }, analogList, 'GET'), target],
  ] as const) {
    try { await call.run(handler); expect(call.res.code).toBe(status); expect(call.res.headers.get('cache-control')).toBe('no-store');
      expect(call.read).not.toHaveBeenCalled(); } finally { call.req.destroy(); call.res.destroy(); }
  }
});

it('preflights without bearer, ignores naked 100 and wrong admission, and never follows redirects', async () => {
  let mode = 'wrong';
  const paths: string[] = [];
  let cleanPreflight = true;
  let narrowed = true;
  let preflightNonce: string | string[] | undefined;
  const server = createTlsServer(tls.options, (req, res) => {
    paths.push(req.url ?? '');
    cleanPreflight &&= req.method === 'HEAD' && !req.headers.authorization && !req.headers.cookie && !req.headers['content-length'] && !req.headers['transfer-encoding'];
    preflightNonce = req.headers['x-bm-analog-challenge'];
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Bm-Analog-Nonce': mode === 'wrong' ? 'wrong' : String(preflightNonce) }).end();
  });
  server.on('checkContinue', (req, res) => {
    paths.push(req.url ?? '');
    const challenge = req.headers['x-bm-analog-challenge'];
    narrowed &&= !req.headers.cookie && !req.headers.referer && !req.headers['x-bm-analog-proof'] && !!req.headers.authorization &&
      typeof challenge === 'string' && challenge !== preflightNonce;
    res.writeContinue(); // Not the fixture admission.
    res.socket?.write(`HTTP/1.1 100 Continue\r\nX-Bm-Analog-Admit: ${preflightNonce}\r\n\r\n`);
    res.writeHead(mode === 'redirect' ? 302 : 403, { 'Cache-Control': 'no-store',
      'X-Bm-Analog-Nonce': String(challenge), Location: '/must-not-follow', Connection: 'close' }).end();
  });
  await listen(server, async port => {
    for (const [state, expected] of [['wrong', 502], ['denied', 403], ['redirect', 502]] as const) {
      mode = state;
      const call = paused({ ...head(), 'Content-Length': '2', Cookie: 'synthetic', Referer: 'http://example.invalid' });
      try { await call.run(makeProdAnalogPages({ port, pin: tls.pin })); expect(call.res.code).toBe(expected); expect(call.text()).toBe('');
        expect(call.read).not.toHaveBeenCalled(); } finally { call.req.destroy(); call.res.destroy(); }
    }
  });
  expect(cleanPreflight && narrowed).toBe(true);
  expect(paths).toEqual(['fixture-identity', 'fixture-identity', 'proposal-import', 'fixture-identity', 'proposal-import']
    .map(path => '/api/v1/prod-analog/' + path));
});

it('sends no HTTP bytes, bearer or workbook after a verified preflight if the actual peer changes or disappears', async () => {
  let preflights = 0;
  const expected = createTlsServer(tls.options, (req, res) => {
    if (req.method === 'HEAD' && !req.headers.authorization && !req.headers['content-length'] && !req.headers['transfer-encoding']) preflights++;
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Bm-Analog-Nonce': String(req.headers['x-bm-analog-challenge']) }).end();
  });
  const wrong = createTlsServer(syntheticLoopbackCertificate().options);
  const rejectedWrongPeer = once(wrong, 'tlsClientError');
  let appBytes = 0;
  wrong.prependListener('secureConnection', socket => socket.on('data', data => { appBytes += data.length; }));
  for (const losePeer of [false, true]) {
    let sockets = 0;
    const samePort = createTcpServer(socket => {
      if (++sockets === 1) expected.emit('connection', socket);
      else if (losePeer) socket.destroy();
      else wrong.emit('connection', socket);
    });
    await listen(samePort, async port => {
      const call = paused({ ...head(), 'Content-Length': '2' });
      try {
        call.req.end(Buffer.from([1, 2]));
        await call.run(makeProdAnalogPages({ port, pin: tls.pin }));
        expect(call.res.code).toBe(502); expect(call.read).not.toHaveBeenCalled();
      } finally { call.req.destroy(); call.res.destroy(); }
    });
    expect(sockets).toBe(2); // preflight and candidate socket only; no fallback or retry
  }
  await rejectedWrongPeer;
  expect(preflights).toBe(2);
  expect(appBytes).toBe(0);
});

it('closes successful list responses to the exact schema and size', async () => {
  let payload: unknown;
  let upstreamStatus = 200;
  const server = createTlsServer(tls.options, (req, res) => {
    const metadata = { 'Cache-Control': 'no-store', 'X-Bm-Analog-Nonce': String(req.headers['x-bm-analog-challenge']) };
    if (req.method === 'HEAD') res.writeHead(204, metadata).end();
    else res.writeHead(upstreamStatus, { ...metadata, 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  const list = { environment: 'prod-analog', kind: 'imports', batches: [], nextCursor: null };
  await listen(server, async port => {
    const handler = makeProdAnalogPages({ port, pin: tls.pin });
    for (const [value, status, wireStatus] of [[list, 200], [{ ...list, environment: 'qa' }, 502],
      [{ ...list, actor: 'private' }, 502], [{ ...list, nextCursor: '4' }, 502], [{ padding: 'x'.repeat(16 * 1024) }, 502],
      [{ error: 'no_released_skill' }, 502, 409]] as const) {
      payload = value;
      upstreamStatus = wireStatus ?? 200;
      const call = paused({ Authorization: `Bearer ${token}` }, analogList, 'GET');
      try { await call.run(handler); expect(call.res.code).toBe(status); expect(call.read).not.toHaveBeenCalled(); }
      finally { call.req.destroy(); call.res.destroy(); }
    }
  });
});

function oracle() {
  const expected = pricePreviewFixture().rows;
  const prices = [['0.151234567891', '0.08123', '0.02956'], ['0.13234', '0.07432', '0.02734'], ['0', '0.07987', '0.02609']];
  expected.forEach((row, i) => row.prices.forEach((price, j) => { price.decimal = prices[i][j]; }));
  return expected;
}

it.skipIf(process.env.BM_PROD_ANALOG_JOINT !== '1')('chains exact released import Pages and Ktor over loopback', async () => {
  const port = Number(process.env.BM_PROD_ANALOG_TEST_PORT);
  const pin = process.env.BM_PROD_ANALOG_TEST_PIN!;
  const actor = process.env.BM_PROD_ANALOG_TEST_ACTOR!;
  const other = process.env.BM_PROD_ANALOG_TEST_OTHER!;
  const [book, marked] = process.env.BM_PROD_ANALOG_TEST_INPUT!.split(':').map(input => Buffer.from(input, 'base64'));
  const phase = process.env.BM_PROD_ANALOG_TEST_PHASE;
  const provenance = JSON.parse(process.env.BM_PROD_ANALOG_TEST_EXPECT!) as Array<{ revisionId: string; artifactSha256: string; generation: string }>;
  expect(process.versions.node.startsWith('20.')).toBe(true);
  expect(Object.keys(process.env).some(name => ['BM_ENV', 'BM_BACKEND_URL', 'NEXT_PUBLIC_APP_ENV'].includes(name))).toBe(false);
  const handler = makeProdAnalogPages({ port, pin });
  await listen(createServer((req, res) => {
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } });
    void handler(req as NextApiRequest, response as NextApiResponse).catch(() => res.destroy());
  }), async pages => {
    const base = `http://127.0.0.1:${pages}`;
    const checked = async (result: Response, status: number) => {
      expect(result.status).toBe(status); expect(result.headers.get('cache-control')).toBe('no-store');
      const text = await result.text(); return text && JSON.parse(text);
    };
    const post = (who = actor, id = 1, body = book, name?: string, headers: Record<string, string> = {}, chunked = false) => {
      const upload: RequestInit & { duplex?: 'half' } = { method: 'POST', redirect: 'error', body, headers: { ...head(who, name, id), ...headers } };
      if (chunked) {
        upload.body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close(); } });
        upload.duplex = 'half';
      }
      return fetch(base + analogPost, upload);
    };
    const get = (who = actor, query = '') => fetch(base + analogList + query, { redirect: 'error', headers: { Authorization: `Bearer ${who}` } });
    const verify = (value: typeof provenance[number], exact: typeof provenance[number]) => {
      expect(value.revisionId === exact.revisionId && value.artifactSha256 === exact.artifactSha256 && value.generation === exact.generation).toBe(true);
    };
    const verifyList = async (who: string, expected: typeof provenance) => {
      const page = await checked(await get(who), 200);
      expect(page.environment).toBe('prod-analog'); expect(page.batches.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        verify(page.batches[i], expected[i]);
        // Check citations, units and exclusions via structural comparison, without printing synthetic prices on mismatch.
        expect(equalJson(page.batches[i].proposals, oracle())).toBe(true);
      }
    };
    if (phase === 'absent') {
      expect(await checked(await post(), 409)).toEqual({ error: 'no_released_skill' });
      expect(await checked(await post('fixture-token'), 401)).toBe('');
      expect(await checked(await post(actor, 1, book, undefined, { 'X-Teach-Revision': 'override' }), 400)).toBe('');
      await verifyList(actor, []);
    } else if (phase === 'A') {
      const stored = await checked(await post(), 201); verify(stored, provenance[0]);
      const byContent = await checked(await post(actor, 2, marked, 'neutral.xlsx', {}, true), 201); verify(byContent, provenance[0]);
      expect(stored.importId !== byContent.importId).toBe(true);
      await verifyList(actor, [provenance[0], provenance[0]]); await verifyList(other, []);
    } else if (phase === 'B') {
      const replay = await checked(await post(), 200); verify(replay, provenance[1]);
      expect(replay.kind).toBe('alreadyStored');
      expect(await checked(await post(actor, 1, marked, 'neutral.xlsx'), 409)).toEqual({ error: 'attempt_mismatch' });
      verify(await checked(await post(actor, 3), 201), provenance[0]);
      await verifyList(other, []);
      verify(await checked(await post(other), 201), provenance[0]);
      await verifyList(other, [provenance[0]]); await verifyList(actor, [provenance[0], provenance[1], provenance[1]]);
      expect((await checked(await get(other, `?cursor=${replay.importId}`), 200)).batches).toEqual([]);
    } else if (phase === 'return-A') {
      verify(await checked(await post(actor, 4), 201), provenance[0]);
      verify(await checked(await post(), 200), provenance[2]);
      await verifyList(actor, [provenance[0], provenance[1], provenance[2], provenance[2]]);
      await verifyList(other, [provenance[1]]);
    } else if (phase === 'invalid-head') {
      expect(await checked(await post(actor, 5), 503)).toBe('');
      verify(await checked(await post(), 200), provenance[2]);
      await verifyList(actor, [provenance[0], provenance[1], provenance[2], provenance[2]]);
    } else throw new Error('Unsupported analogue phase');
  });
}, 20_000);

function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}
