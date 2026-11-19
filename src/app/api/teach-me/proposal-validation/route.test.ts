// @vitest-environment node

import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import proposalValidation, { config } from '@/pages/api/teach-me/proposal-validation';
import proposalImports from '@/pages/api/teach-me/proposal-imports';
import proposalImport from '@/pages/api/teach-me/proposal-import';
import { forwardTeachProposalImport } from '@/lib/teach-workbook-proxy';
import { importAttemptHeader, importPath, importsPath, validationPath } from '@/lib/teach-proposal-import';
import { workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';
import { pricePreviewFixture } from '@/lib/teach-draft-preview.testing';

const qa = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/env', async (original) => process.env.BM_TEACH_VALIDATION_TEST_PORT ? original() : { get isQA() { return qa.value; } });
const realFetch = globalThis.fetch;
const upstream = vi.fn();
const bearer = 'Bearer fixture-token';
const authorized = { Authorization: bearer };
const ref = '00000000-0000-4000-8000-000000000001';
const request = JSON.stringify({ validationRef: ref, confirmExpectedPrices: true });
const revisionId = 'a'.repeat(64);
const validatedAt = '2026-03-01T10:11:12.123456Z';
const receipt = { kind: 'validated', importId: '37', revisionId, generation: '1', validatedAt };

function oracle() {
  const rows = pricePreviewFixture().rows;
  const prices = [['0.151234567891', '0.08123', '0.02956'], ['0.13234', '0.07432', '0.02734'], ['0', '0.07987', '0.02609']];
  rows.forEach((row, i) => row.prices.forEach((price, j) => { price.decimal = prices[i][j]; }));
  return rows;
}

beforeEach(() => {
  qa.value = true;
  vi.stubGlobal('fetch', upstream.mockReset());
  vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'true');
  vi.stubEnv('BM_TEACH_VALIDATION_PILOT', 'true');
  vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('rejects invalid raw headers, non-canonical query, method, off modes and destinations before opening the stream', async () => {
  expect(config.api.bodyParser).toBe(false);
  const post = ['Authorization', bearer, 'Content-Type', 'application/json', 'Content-Length', '80'];
  const get = ['Authorization', bearer];
  const cases: [number, string, string, string[], (() => void)?][] = [
    [405, 'GET', validationPath, post], [401, 'POST', validationPath, [...post, ...get]],
    [400, 'POST', validationPath + '?validation=1', post], [400, 'POST', validationPath, [...post, 'X-HTTP-Method-Override', 'GET']],
    [400, 'POST', validationPath, [...post, 'Content-Disposition', 'attachment']],
    [400, 'POST', validationPath, [...post, 'Transfer-Encoding', 'chunked']],
    [400, 'POST', validationPath, [...post, 'Content-Type', 'application/json']],
    [400, 'POST', validationPath, [...post, 'Content-Length', '80']],
    [413, 'POST', validationPath, [...post.slice(0, -1), '1025']],
    [415, 'POST', validationPath, [...post, 'Content-Encoding', 'gzip']],
    [404, 'POST', validationPath, post, () => { qa.value = false; }],
    [404, 'POST', validationPath, post, () => vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'false')],
    [404, 'GET', importsPath + '?validation=1', get, () => vi.stubEnv('BM_TEACH_VALIDATION_PILOT', 'false')],
    [400, 'GET', importsPath + '?validation=1&validation=1', get], [400, 'GET', importsPath + '?cursor=11&validation=1', get],
    [400, 'GET', importsPath + '?validation=1&cursor=01', get], [400, 'GET', importsPath + '?validation=1', [...get, 'X-Teach-UID', 'synthetic']],
    [502, 'POST', validationPath, post, () => vi.stubEnv('BM_BACKEND_URL', 'http://localhost:12345')],
    [502, 'POST', validationPath, post, () => vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345/?x=1')],
  ];
  for (const [status, method, url, rawHeaders, configure] of cases) {
    qa.value = true;
    vi.stubEnv('BM_TEACH_IMPORT_PILOT', 'true');
    vi.stubEnv('BM_TEACH_VALIDATION_PILOT', 'true');
    vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345'); configure?.();
    const req = Object.assign(new PassThrough(), { method, url, rawHeaders });
    const read = vi.spyOn(req, 'read');
    const res = Object.assign(new PassThrough(), { statusCode: 0, headers: new Headers(),
      setHeader(key: string, value: string) { this.headers.set(key, value); },
      status(code: number) { this.statusCode = code; return this; } });
    await (url.startsWith(importsPath) ? proposalImports : proposalValidation)(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(read).not.toHaveBeenCalled(); req.destroy(); res.destroy();
  }
  expect(upstream).not.toHaveBeenCalled();
});

it('streams confirmation without parsing it and closes the response schemas at both bounds', async () => {
  function proxy(query?: string) {
    const headers = new Headers(query === undefined ? { ...authorized, 'Content-Type': 'application/json', 'Content-Length': String(request.length) } : authorized);
    return forwardTeachProposalImport({ url: query === undefined ? validationPath : importsPath + query, signal: new AbortController().signal,
      body: () => { if (query !== undefined) throw new Error('GET read'); return new Response(request).body; },
      names: () => [...headers.keys()], values: name => headers.has(name) ? [headers.get(name)!] : [],
    }, query === undefined ? 'proposal-validation' : 'proposal-imports');
  }
  for (const [value, status, expected] of [[receipt, 201, 201], [{ ...receipt, kind: 'alreadyValidated' }, 200, 200],
    [receipt, 200, 502], [{ ...receipt, validationRef: ref }, 201, 502], [{ ...receipt, validatedAt: '2026-02-31T12:00:00Z' }, 201, 502],
    [{ ...receipt, padding: 'x'.repeat(2048) }, 201, 502], [{ payload: 'not reflected' }, 404, 404]] as const) {
    upstream.mockImplementationOnce(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:12345/api/v1/teach-me/proposal-validation');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { ...authorized, 'Content-Type': 'application/json', 'Content-Length': String(request.length) } });
      expect(await new Response(init.body).text()).toBe(request);
      return Response.json(value, { status });
    });
    const response = await proxy();
    expect(response.status).toBe(expected);
    if (expected >= 400) expect(await response.text()).toBe('');
  }
  const maximum = Array.from({ length: 4 }, (_, i) => {
    const rows = oracle();
    rows.forEach((row, j) => {
      const prefix = ['\\', '"', '\\"'][j];
      row.proposal = prefix + '\\'.repeat(96 - prefix.length); // 96 bytes, each escaped on the wire
      row.prices.forEach(price => { price.decimal = '999999.999999999999'; });
    });
    return { importId: String(BigInt('9223372036854775807') - BigInt(i)), supplierKey: 'gesternova', revisionId,
      generation: '9223372036854775807', importedAt: validatedAt, proposals: rows,
      validationRef: ref.slice(0, -1) + i, validation: { kind: 'validated', validatedAt } };
  });
  const page = { kind: 'imports', batches: maximum, nextCursor: maximum[3].importId };
  upstream.mockResolvedValueOnce(Response.json(page));
  const complete = await proxy('?validation=1');
  expect(complete.status).toBe(200);
  const serialized = await complete.text();
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16384);
  expect(JSON.parse(serialized)).toEqual(page);
  upstream.mockResolvedValueOnce(Response.json(page));
  expect((await proxy('')).status).toBe(502); // normal list must never carry refs
  upstream.mockResolvedValueOnce(Response.json({ ...page, batches: [{ ...maximum[0], validation: { ...maximum[0].validation, actor: 'synthetic' } }] }));
  expect((await proxy('?validation=1')).status).toBe(502);
});

it.skipIf(!process.env.BM_TEACH_VALIDATION_TEST_PORT)('chains exact validation Pages proxy and Ktor over loopback', async () => {
  const port = Number(process.env.BM_TEACH_VALIDATION_TEST_PORT);
  expect(Number.isInteger(port) && port > 0 && port <= 65535).toBe(true);
  vi.stubGlobal('fetch', realFetch);
  vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
  const server = createServer((req, res) => {
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } }) as unknown as NextApiResponse;
    const handler = req.url?.startsWith(importsPath) ? proposalImports : req.url === importPath ? proposalImport : proposalValidation;
    void handler(req as NextApiRequest, response).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = async (path: string, status: number, init: RequestInit = { headers: authorized }) => {
      const response = await realFetch(origin + path, { ...init, redirect: 'error' });
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    };
    const list = importsPath + '?validation=1';
    const validate = (value: unknown, status: number, token = bearer) => send(validationPath, status, { method: 'POST', body: JSON.stringify(value),
      headers: { Authorization: token, 'Content-Type': 'application/json' } });
    expect(await send(list, 200)).toEqual({ kind: 'imports', nextCursor: null, batches: [] });
    await validate({ validationRef: ref, confirmExpectedPrices: true }, 404);
    const a = await send(importPath, 201, { method: 'POST', body: Buffer.from(process.env.BM_TEACH_VALIDATION_TEST_BOOK!, 'base64'),
      headers: { ...authorized, 'Content-Type': workbookMediaType, [workbookFilenameHeader]: Buffer.from('bm-pilot-gesternova.xlsx').toString('base64url'),
        [importAttemptHeader]: 'a'.repeat(32) } });
    const read = await send(list, 200);
    expect(read).toEqual({ kind: 'imports', nextCursor: null, batches: [{ importId: a.importId, supplierKey: 'gesternova',
      revisionId: process.env.BM_TEACH_VALIDATION_TEST_REVISION, generation: '1', importedAt: expect.any(String),
      proposals: oracle(), validationRef: expect.any(String), validation: null }] });
    const target = { validationRef: read.batches[0].validationRef, confirmExpectedPrices: true };
    expect(await send(list, 200, { headers: { Authorization: 'Bearer other-token' } })).toEqual({ ...read, batches: [] });
    await send(list, 403, { headers: { Authorization: 'Bearer not-nominated' } });
    expect(await validate(target, 404, 'Bearer other-token')).toBeNull();
    await validate(target, 403, 'Bearer not-nominated');
    await validate({ ...target, confirmExpectedPrices: false }, 400);
    const result = await validate(target, 201);
    expect(result).toEqual({ kind: 'validated', importId: a.importId, revisionId: a.revisionId, generation: '1', validatedAt: expect.any(String) });
    expect(await validate(target, 200)).toEqual({ ...result, kind: 'alreadyValidated' });
    expect((await send(list, 200)).batches[0].validation).toEqual({ kind: 'validated', validatedAt: result.validatedAt });
    expect((await send(importsPath, 200)).batches[0]).not.toHaveProperty('validationRef');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 25_000);
