// @vitest-environment node

import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import proposalImport, { config } from '@/pages/api/teach-me/proposal-import';
import proposalImports, { config as listConfig } from '@/pages/api/teach-me/proposal-imports';
import { forwardTeachProposalImport } from '@/lib/teach-workbook-proxy';
import { importAttemptHeader, importPath, importsPath } from '@/lib/teach-proposal-import';
import { workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';
import { pricePreviewFixture } from '@/lib/teach-draft-preview.testing';

const qa = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/env', async (original) => process.env.BM_TEACH_IMPORT_TEST_PORT ? original() : { get isQA() { return qa.value; } });
const realFetch = globalThis.fetch;
const upstream = vi.fn();
const bearer = 'Bearer fixture-token';
const name = (filename: string) => Buffer.from(filename).toString('base64url');
const head = { Authorization: bearer, 'Content-Type': workbookMediaType,
  [workbookFilenameHeader]: name('bm-pilot-gesternova.xlsx'), [importAttemptHeader]: 'a'.repeat(32) };
const receipt = { kind: 'stored', importId: '37', revisionId: 'a'.repeat(64), generation: '1', proposalCount: 3 };

function oracle() {
  const expected = pricePreviewFixture().rows;
  const prices = [['0.151234567891', '0.08123', '0.02956'], ['0.13234', '0.07432', '0.02734'], ['0', '0.07987', '0.02609']];
  expected.forEach((row, i) => row.prices.forEach((price, j) => { price.decimal = prices[i][j]; }));
  return expected;
}
const list = (id = '37') => ({ kind: 'imports', nextCursor: null, batches: [{
  importId: id, supplierKey: 'gesternova', revisionId: receipt.revisionId, generation: '1', importedAt: '2026-03-01T10:11:12.123456Z', proposals: oracle(),
}] });

beforeEach(() => {
  qa.value = true;
  vi.stubGlobal('fetch', upstream.mockReset());
  vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'true');
  vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('denies raw method, auth, framing, overrides, off modes and non-loopback without reading uploads', async () => {
  expect(config.api.bodyParser).toBe(false);
  expect(listConfig.api.bodyParser).toBe(false);
  const post = Object.entries({ ...head, 'Content-Length': '2' }).flat();
  const get = ['Authorization', bearer];
  const cases: [number, string, string, string[], () => void][] = [
    [405, 'GET', importPath, post, () => {}], [405, 'POST', importsPath, get, () => {}],
    [404, 'POST', importPath, post, () => { qa.value = false; }],
    [404, 'GET', importsPath, get, () => { vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'false'); }],
    [502, 'POST', importPath, post, () => { vi.stubEnv('BM_BACKEND_URL', 'http://localhost:12345'); }],
    [502, 'GET', importsPath, get, () => { vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345/extra'); }],
    [401, 'POST', importPath, [...post, 'Authorization', bearer], () => {}],
    [400, 'POST', importPath, [...post, importAttemptHeader, '8'.repeat(32)], () => {}],
    [400, 'POST', importPath, [...post, 'Transfer-Encoding', 'chunked'], () => {}],
    [400, 'POST', importPath, [...post, 'X-Teach-Manifest', 'test'], () => {}],
    [400, 'POST', importPath + '?x=1', post, () => {}],
    [400, 'GET', importsPath, [...get, 'Content-Length', '1'], () => {}],
    [400, 'GET', importsPath, [...get, 'X-Teach-Uid', 'synthetic'], () => {}],
    [400, 'GET', importsPath + '?cursor=1&cursor=1', get, () => {}],
    [400, 'GET', importsPath + '?cursor=01', get, () => {}],
    [400, 'GET', importsPath + '?cursor=9223372036854775808', get, () => {}],
  ];
  for (const [status, method, url, rawHeaders, configure] of cases) {
    qa.value = true;
    vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'true');
    vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345');
    configure();
    const req = Object.assign(new PassThrough(), { method, url, rawHeaders });
    const read = vi.spyOn(req, 'read');
    const res = Object.assign(new PassThrough(), { statusCode: 0, headers: new Headers(),
      setHeader(key: string, value: string) { this.headers.set(key, value); },
      status(code: number) { this.statusCode = code; return this; } });
    await (url.startsWith(importsPath) ? proposalImports : proposalImport)(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(read).not.toHaveBeenCalled(); req.destroy(); res.destroy();
  }
  expect(upstream).not.toHaveBeenCalled();
});

function forward({ isList = false, cursor = '', bytes = new Uint8Array([1, 2]) } = {}) {
  const headers = new Headers(isList ? { Authorization: bearer } : { ...head, 'Transfer-Encoding': 'chunked' });
  return forwardTeachProposalImport({ url: isList ? importsPath + cursor : importPath, signal: new AbortController().signal,
    body: () => { if (isList) throw new Error('GET read'); return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); },
    names: () => [...headers.keys()], values: (name) => headers.has(name) ? [headers.get(name)!] : [],
  }, isList ? 'proposal-imports' : 'proposal-import');
}

it('bounds upload and closes response schemas over status, units, decimal strings, pagination and UTF-8', async () => {
  const respond = (response: Response) => upstream.mockImplementationOnce(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:12345\/api\/v1\/teach-me\/proposal-imports?/);
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
    if (init.body) { try { await new Response(init.body).arrayBuffer(); } catch { /* intentional over-limit */ } }
    return response;
  });
  for (const [payload, status, expected] of [[receipt, 201, 201], [{ ...receipt, kind: 'alreadyStored' }, 200, 200],
    [receipt, 200, 502], [{ ...receipt, attempt: 'private' }, 201, 502], [{ ...receipt, generation: '01' }, 201, 502],
    [{ error: 'incompatible_workbook' }, 409, 409], [{ error: 'not-canonical' }, 409, 502]] as const) {
    respond(Response.json(payload, { status }));
    const res = await forward();
    expect(res.status).toBe(expected);
    expect(res.headers.get('cache-control')).toBe('no-store');
    if (expected === 502) expect(await res.text()).toBe('');
  }
  respond(Response.json(receipt, { status: 201 }));
  expect((await forward({ bytes: new Uint8Array(5 * 1024 * 1024 + 1) })).status).toBe(413);
  respond(new Response(new Uint8Array([0xfe, 0xff]), { status: 201, headers: { 'Content-Type': 'application/json' } }));
  expect((await forward()).status).toBe(502);
  respond(new Response(`{"padding":"${'x'.repeat(4096)}"}`, { status: 201, headers: { 'Content-Type': 'application/json' } }));
  expect((await forward()).status).toBe(502);
  const valid = list();
  const tainted = list(); tainted.batches[0].proposals[0].prices[0].decimal += '0';
  const unit = list(); Object.assign(unit.batches[0].proposals[0].prices[0], { unit: '€/MWh' });
  for (const [payload, cursor, status] of [[valid, '?cursor=38', 200], [valid, '?cursor=37', 502], [tainted, '', 502], [unit, '', 502],
    [{ ...valid, nextCursor: '37' }, '', 502], [{ ...valid, batches: [...valid.batches, ...valid.batches] }, '', 502]] as const) {
    respond(Response.json(payload));
    expect((await forward({ isList: true, cursor })).status).toBe(status);
  }
  respond(new Response(`{"padding":"${'x'.repeat(16 * 1024)}"}`, { headers: { 'Content-Type': 'application/json' } }));
  expect((await forward({ isList: true })).status).toBe(502);
  const maximum = Array.from({ length: 4 }, (_, i) => {
    const batch = list(String(BigInt('9223372036854775807') - BigInt(i))).batches[0];
    batch.proposals.forEach((row, j) => {
      row.proposal = String(j) + '\\'.repeat(95); // maximum escaped size
      row.prices.forEach(price => { price.decimal = '999999.999999999999'; });
    });
    return { ...batch, generation: '9223372036854775807' };
  });
  respond(Response.json({ kind: 'imports', batches: maximum, nextCursor: maximum[3].importId }));
  const largest = await forward({ isList: true });
  expect(largest.status).toBe(200);
  expect(Buffer.byteLength(await largest.text())).toBeLessThanOrEqual(16384);
});

it.skipIf(!process.env.BM_TEACH_IMPORT_TEST_PORT)('chains exact import Pages proxy and Ktor over loopback', async () => {
  const port = Number(process.env.BM_TEACH_IMPORT_TEST_PORT);
  expect(Number.isInteger(port) && port > 0 && port <= 65535).toBe(true);
  vi.stubGlobal('fetch', realFetch);
  vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
  const server = createServer((req, res) => {
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } }) as unknown as NextApiResponse;
    const handler = req.url?.startsWith(importsPath) ? proposalImports : proposalImport;
    void handler(req as NextApiRequest, response).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const revisionId = process.env.BM_TEACH_IMPORT_TEST_REVISION;
    const send = async (path: string, status: number, init: RequestInit) => {
      const response = await realFetch(origin + path, { ...init, redirect: 'error' });
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const result = await response.text();
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(path === importsPath ? 16384 : 4096);
      return result ? JSON.parse(result) : null;
    };
    const headers = { Authorization: bearer };
    const get = (auth = bearer) => send(importsPath, 200, { headers: { Authorization: auth } });
    const post = (fixture: string, filename: string, attempt: string, status: number, auth = bearer) => send(importPath, status, {
      method: 'POST', body: Buffer.from(process.env[`BM_TEACH_IMPORT_TEST_${fixture}`]!, 'base64'),
      headers: { ...head, Authorization: auth, [workbookFilenameHeader]: name(filename), [importAttemptHeader]: attempt.repeat(32) },
    });
    expect(await get()).toEqual({ kind: 'imports', batches: [], nextCursor: null });
    await send(importsPath, 403, { headers: { Authorization: 'Bearer not-nominated' } });
    await post('BOOK', 'bm-pilot-gesternova.xlsx', 'a', 401, 'Bearer invalid');
    const a = await post('BOOK', 'bm-pilot-gesternova.xlsx', 'a', 201);
    expect(a).toEqual({ kind: 'stored', importId: expect.any(String), revisionId, generation: '1', proposalCount: 3 });
    const first = await get();
    expect(first).toEqual({ kind: 'imports', nextCursor: null, batches: [{ importId: a.importId, supplierKey: 'gesternova',
      revisionId, generation: '1', importedAt: expect.any(String), proposals: oracle() }] });
    expect(await get('Bearer other-token')).toEqual({ kind: 'imports', batches: [], nextCursor: null });
    expect(await post('INCOMPATIBLE', 'bm-pilot-gesternova.xlsx', 'b', 409)).toEqual({ error: 'incompatible_workbook' });
    expect(await get()).toEqual(first);
    expect(await post('BOOK', 'bm-pilot-gesternova.xlsx', 'a', 200)).toEqual({ ...a, kind: 'alreadyStored' });
    const b = await post('MARKED', 'carga.xlsx', 'b', 201);
    const both = await send(importsPath, 200, { headers });
    expect(both).toEqual({ ...first, batches: [{ ...first.batches[0], importId: b.importId, importedAt: expect.any(String) }, ...first.batches] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 20_000);
