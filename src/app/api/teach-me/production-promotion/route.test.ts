// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import handle, { config } from '@/pages/api/teach-me/production-promotion';
import listImports from '@/pages/api/teach-me/proposal-imports';
import { importsPath } from '@/lib/teach-proposal-import';
import { promotionPath, promotionRefHeader } from '@/lib/teach-production-promotion';
import { forwardTeachProposalImport } from '@/lib/teach-workbook-proxy';

const qa = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/env', async original => process.env.BM_TEACH_PROMOTION_TEST_PORT ? original() : { get isQA() { return qa.value; } });
const authorization = 'Bearer fixture-token';
const ref = '00000000-0000-4000-8000-000000000001';
const input = JSON.stringify({ validationRef: ref, confirmPromotion: true });
const at = '2026-03-01T10:11:12Z';
const exact = { importId: '37', revisionId: 'a'.repeat(64), generation: '1', validatedAt: at };
const opened = { kind: 'opened', ...exact, url: 'https://pr-pilot.invalid/bm-pilot/skills-fixture/pull/42', openedAt: at };

beforeEach(() => {
  qa.value = true;
  vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'true'); vi.stubEnv('BM_TEACH_VALIDATION_PILOT', 'true');
  vi.stubEnv('BM_TEACH_PROMOTION_PILOT', 'true'); vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('rejects invalid raw headers, noncanonical selectors, disabled opt-ins and non-loopback before opening body', async () => {
  expect(config.api.bodyParser).toBe(false);
  const post = ['Authorization', authorization, 'Content-Type', 'application/json', 'Content-Length', String(input.length)];
  const get = ['Authorization', authorization, promotionRefHeader, ref];
  const cases: [number, string, string[], string?, (() => void)?][] = [
    [405, 'PATCH', post], [401, 'POST', [...post, 'Authorization', authorization]], [400, 'POST', [...post, promotionRefHeader, ref]],
    [400, 'POST', [...post, 'Idempotency-Key', 'opaque']], [400, 'POST', [...post, 'Transfer-Encoding', 'chunked']],
    [400, 'POST', [...post, 'Content-Type', 'application/json']], [400, 'POST', [...post, 'Content-Length', '80']],
    [415, 'POST', [...post, 'Content-Encoding', 'gzip']], [413, 'POST', [...post.slice(0, -1), '1025']],
    [400, 'GET', get, '?'], [400, 'GET', [...get, promotionRefHeader, ref]],
    [400, 'GET', [...get, 'Content-Length', '1']], [400, 'GET', [...get.slice(0, -1), 'f' + ref.slice(1).toUpperCase() + 'A']],
    [400, 'GET', get.slice(0, 2)], [404, 'GET', get, '', () => { qa.value = false; }],
    [404, 'GET', get, '', () => vi.stubEnv('BM_TEACH_VALIDATION_PILOT', 'false')],
    [404, 'GET', get, '', () => vi.stubEnv('BM_TEACH_PROMOTION_PILOT', 'false')],
    [502, 'GET', get, '', () => vi.stubEnv('BM_BACKEND_URL', 'http://localhost:12345')],
  ];
  for (const [status, method, rawHeaders, query = '', configure] of cases) {
    qa.value = true; vi.stubEnv('BM_TEACH_VALIDATION_PILOT', 'true'); vi.stubEnv('BM_TEACH_PROMOTION_PILOT', 'true');
    vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345'); configure?.();
    const req = Object.assign(new PassThrough(), { method, url: promotionPath + query, rawHeaders });
    const read = vi.spyOn(req, 'read');
    const res = Object.assign(new PassThrough(), { statusCode: 0, headers: new Headers(),
      setHeader(key: string, value: string) { this.headers.set(key, value); },
      status(code: number) { this.statusCode = code; return this; } });
    await handle(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(status); expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(read).not.toHaveBeenCalled(); req.destroy(); res.destroy();
  }
});

async function local(server: Server, run: (port: number) => Promise<void>) {
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); await run((server.address() as AddressInfo).port); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}

it('keeps denied or ordinary-100 bodies unopened and closes upstream method, header and result shapes', async () => {
  let mode: 'denied' | 'ordinary' | 'opened' | 'extra' | 'oversized' | 'redirect' = 'denied';
  const requests = vi.fn();
  const server = createServer();
  server.on('checkContinue', (req, res) => {
    requests(req.url, req.headers);
    if (mode === 'denied' || mode === 'ordinary') {
      if (mode === 'ordinary') res.writeContinue();
      res.writeHead(403); res.end(); return;
    }
    res.socket?.write('HTTP/1.1 100 Continue\r\nX-Teach-Promotion-Continue: fixture-v1\r\n\r\n');
    let text = '';
    req.on('data', bytes => { text += bytes.toString(); });
    req.on('end', () => {
      if (text !== input) { res.writeHead(400); res.end(); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); res.end(); return; }
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(mode === 'extra' ? { ...opened, actor: 'must-not-pass' } : mode === 'oversized' ? { ...opened, pad: 'x'.repeat(2048) } : opened));
    });
  });
  await local(server, async port => {
    vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
    const fields = new Headers({ Authorization: authorization, 'Content-Type': 'application/json', 'Content-Length': String(input.length), Cookie: 'synthetic-cookie' });
    const open = vi.fn(() => new Response(input).body);
    const proxy = () => forwardTeachProposalImport({ url: promotionPath, signal: new AbortController().signal,
      body: open, names: () => [...fields.keys()], values: name => fields.has(name) ? [fields.get(name)!] : [] }, 'production-promotion');
    expect((await proxy()).status).toBe(403);
    mode = 'ordinary'; expect((await proxy()).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
    mode = 'opened'; const result = await proxy(); expect(result.status).toBe(201); expect(await result.json()).toEqual(opened);
    expect(requests.mock.calls[2]).toEqual(['/api/v1/teach-me/production-promotion', {
      authorization, connection: 'close', 'content-length': String(input.length), 'content-type': 'application/json', expect: '100-continue', host: `127.0.0.1:${port}`,
    }]);
    for (const malformed of ['extra', 'oversized', 'redirect'] as const) { mode = malformed; expect((await proxy()).status).toBe(502); }
  });
});

it('GET forwards only its canonical ref and bearer and rejects a different origin, path or URL spelling', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const fields = new Headers({ Authorization: authorization, [promotionRefHeader]: ref });
  const proxy = () => forwardTeachProposalImport({ url: promotionPath, signal: new AbortController().signal,
    body: () => { throw new Error('GET read'); }, names: () => [...fields.keys()], values: name => fields.has(name) ? [fields.get(name)!] : [] }, 'production-promotion', true);
  fetcher.mockResolvedValueOnce(Response.json(opened)); expect(await (await proxy()).json()).toEqual(opened);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: authorization, [promotionRefHeader]: ref } });
  for (const url of [opened.url + '?query', opened.url.replace('/pull/', '/pr/'), opened.url.replace('https://', 'http://'),
    opened.url + '/', opened.url.replace('/42', '/042'), opened.url.replace('.invalid', '.invalid@testing.invalid')]) {
    fetcher.mockResolvedValueOnce(Response.json({ ...opened, url })); expect((await proxy()).status).toBe(502);
  }
});

it.skipIf(!process.env.BM_TEACH_PROMOTION_TEST_PORT)('chains exact promotion Pages proxy and Ktor over loopback', async () => {
  const port = Number(process.env.BM_TEACH_PROMOTION_TEST_PORT);
  expect(Number.isInteger(port) && port > 0 && port <= 65535).toBe(true);
  vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
  const server = createServer((req, res) => {
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } }) as unknown as NextApiResponse;
    void (req.url?.startsWith(importsPath) ? listImports : handle)(req as NextApiRequest, response).catch(() => res.destroy());
  });
  await local(server, async pages => {
    const send = async (path: string, status: number, init: RequestInit) => {
      const response = await fetch(`http://127.0.0.1:${pages}${path}`, { ...init, redirect: 'error' });
      expect(response.status).toBe(status); expect(response.headers.get('Cache-Control')).toBe('no-store');
      const text = await response.text(); return text && JSON.parse(text);
    };
    const snapshots = await send(importsPath + '?validation=1', 200, { headers: { Authorization: authorization } });
    const [b, a] = snapshots.batches;
    expect(a).toMatchObject({ generation: '1', validation: { kind: 'validated' }, revisionId: process.env.BM_TEACH_PROMOTION_TEST_A });
    expect(b).toMatchObject({ generation: '2', validation: null, revisionId: process.env.BM_TEACH_PROMOTION_TEST_B });
    const read = (target: string, status: number, token = authorization) => send(promotionPath, status,
      { headers: { Authorization: token, [promotionRefHeader]: target } });
    const post = (target: string, status: number, token = authorization, body?: string) => send(promotionPath, status,
      { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body ?? JSON.stringify({ validationRef: target, confirmPromotion: true }) });
    await post(a.validationRef, 403, 'Bearer not-nominated');
    await post(a.validationRef, 404, 'Bearer other-token');
    await read(a.validationRef, 404, 'Bearer other-token');
    await post(b.validationRef, 404); await read(b.validationRef, 404);
    await post(a.validationRef, 400, authorization, `{"validationRef":"${a.validationRef}","confirmPromotion":true,"confirmPromotion":true}`);
    const target = { importId: a.importId, revisionId: a.revisionId, generation: a.generation, validatedAt: a.validation.validatedAt };
    expect(await read(a.validationRef, 200)).toEqual({ kind: 'notRequested', ...target });
    const original = await post(a.validationRef, 201);
    expect(original).toEqual({ kind: 'opened', ...target, url: expect.stringMatching(/^https:\/\/pr-pilot\.invalid\/bm-pilot\/skills-fixture\/pull\/[1-9][0-9]*$/), openedAt: expect.any(String) });
    expect(await read(a.validationRef, 200)).toEqual(original);
    expect(await post(a.validationRef, 200)).toEqual(original);
  });
}, 25_000);
