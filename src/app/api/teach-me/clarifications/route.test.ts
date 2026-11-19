// @vitest-environment node

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import handler, { config } from '@/pages/api/teach-me/clarifications';
import { forwardTeachUpload } from '@/lib/teach-workbook-proxy';
import { clarificationBodyLimit, clarificationMediaType } from '@/lib/teach-clarification';
import { supplierDraftBodyLimit, supplierDraftMediaType } from '@/lib/teach-supplier-draft';
import { workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const qa = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/env', async (importOriginal) => process.env.BM_TEACH_CLARIFY_TEST_PORT || process.env.BM_TEACH_DRAFT_TEST_PORT
  ? importOriginal() : { get isQA() { return qa.value; } });

const pathname = '/api/teach-me/clarifications';
const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': clarificationMediaType };
const draftHeaders = { ...headers, 'Content-Type': supplierDraftMediaType };
const question = { kind: 'question', workbookSha256: 'a'.repeat(64), candidates: [{ sheet: 'Tarifas', a1: 'B2' }, { sheet: 'Tarifas', a1: 'C2' }] };
const fetchUpstream = vi.fn();
const realFetch = globalThis.fetch;

function draftResult(a1: string, digest = question.workbookSha256) {
  return { kind: 'draft', draft: { schemaVersion: 1, supplierKey: 'demo-electricidad', workbookSha256: digest,
    rule: { kind: 'fixed_price_column', header: { sheet: 'Tarifas', a1 } },
    revisionId: createHash('sha256').update(`bm.teach.supplier-draft/v1\ndemo-electricidad\n${digest}\nfixed_price_column\nTarifas\n${a1}`).digest('hex') } };
}

beforeEach(() => {
  qa.value = true;
  vi.stubGlobal('fetch', fetchUpstream.mockReset());
  vi.stubEnv('BM_BACKEND_URL', 'http://qa.invalid');
  vi.stubEnv('NEXT_PUBLIC_TEACH_CLARIFY_LOCAL', 'true');
  vi.stubEnv('NEXT_PUBLIC_TEACH_DRAFT_LOCAL', undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function post({ body = stream(Uint8Array.of(1)), requestHeaders = new Headers(headers), url = pathname,
                path = 'clarifications', signal = new AbortController().signal }: {
  body?: ReadableStream<Uint8Array>; requestHeaders?: Headers; url?: string; path?: 'clarifications' | 'messages'; signal?: AbortSignal;
} = {}) {
  return forwardTeachUpload({ url, signal, body: () => body,
    values: (name) => { const value = requestHeaders.get(name); return value === null ? [] : [value]; } }, path);
}

function stream(...parts: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ pull(controller) {
    const part = parts.shift();
    if (part) controller.enqueue(part); else controller.close();
  } }, { highWaterMark: 0 });
}

async function consume(init: RequestInit, received: (bytes: Uint8Array) => void = () => {}) {
  const reader = (init.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received(value);
    }
  } finally { reader.releaseLock(); }
}

it('guards QA, the default-off opt-in and raw singleton headers without reading or forwarding', async () => {
  expect(config.api.bodyParser).toBe(false);
  const raw = Object.entries(headers).flat();
  for (const [status, flag, isQA, rawHeaders, url] of [
    [404, undefined, true, raw, pathname],
    [404, 'true', false, raw, pathname],
    [401, 'true', true, ['Content-Type', clarificationMediaType], pathname],
    [401, 'true', true, [...raw, 'authorization', 'Bearer another'], pathname],
    [400, 'true', true, [...raw, 'content-type', clarificationMediaType], pathname],
    [400, 'true', true, raw, `${pathname}?extra=1`],
    [415, 'true', true, [...raw, 'content-encoding', 'identity'], pathname],
    [415, 'true', true, ['Authorization', headers.Authorization, 'Content-Type', `${clarificationMediaType}; charset=utf-8`], pathname],
  ] as const) {
    vi.stubEnv('NEXT_PUBLIC_TEACH_CLARIFY_LOCAL', flag);
    qa.value = isQA;
    const req = Object.assign(new PassThrough(), { method: 'POST', url, rawHeaders });
    const read = vi.spyOn(req, 'read');
    const res = Object.assign(new PassThrough(), { statusCode: 0, headers: new Headers(),
      setHeader(name: string, value: string) { this.headers.set(name, value); },
      status(code: number) { this.statusCode = code; return this; } });
    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(read).not.toHaveBeenCalled();
    req.destroy(); res.destroy();
  }
  expect(fetchUpstream).not.toHaveBeenCalled();
});

it('forwards opaque original bytes with canonical headers and counts actual length including the inclusive cap', async () => {
  const slices = [Uint8Array.of(0, 0, 0, 3), Uint8Array.of(91, 49, 93), new Uint8Array(clarificationBodyLimit - 7)];
  const received: Uint8Array[] = [];
  fetchUpstream.mockImplementation(async (url, init) => {
    expect(url).toBe('http://qa.invalid/api/v1/teach-me/clarifications');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', duplex: 'half', cache: 'no-store' });
    expect(init.headers).toEqual(headers);
    await consume(init, (bytes) => received.push(bytes));
    return Response.json(question);
  });
  const requestHeaders = new Headers({ ...headers, 'Content-Type': clarificationMediaType.toUpperCase(),
    'Content-Length': '1', Cookie: 'unrelated=yes', 'X-Other': 'ignored' });
  const ok = await post({ body: stream(...slices), requestHeaders });
  expect(ok.status).toBe(200);
  expect(ok.headers.get('Cache-Control')).toBe('no-store');
  expect(await ok.json()).toEqual(question);
  expect(received.every((chunk, index) => chunk === slices[index])).toBe(true);
  received.length = 0;
  const excess = await post({ body: stream(...slices, Uint8Array.of(7)), requestHeaders });
  expect(excess.status).toBe(413);
  expect(received).toHaveLength(3);
});

it('preserves sanitized statuses and rejects malformed, oversized or out-of-profile upstream success', async () => {
  fetchUpstream.mockResolvedValueOnce(new Response('do not reflect this', { status: 409 }));
  const conflict = await post();
  expect(conflict.status).toBe(409);
  expect(await conflict.text()).toBe('');
  for (const response of [
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(question)),
    new Response(`${' '.repeat(4096)}{}`, { headers: { 'Content-Type': 'application/json' } }),
    Response.json({ ...question, answer: 'extra' }),
    Response.json({ ...question, workbookSha256: 'A'.repeat(64) }),
    Response.json({ ...question, candidates: [question.candidates[0], question.candidates[0]] }),
    Response.json({ ...question, candidates: [question.candidates[0], { sheet: 'A/B', a1: 'C2' }] }),
    Response.json({ ...question, candidates: [question.candidates[0], { sheet: 'A', a1: 'XFE2' }] }),
    new Response('private failure', { status: 500 }),
  ]) {
    fetchUpstream.mockImplementationOnce(async (_, init) => { await consume(init); return response; });
    const result = await post();
    expect(result.status).toBe(502);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.text()).toBe('');
  }
});

it('shares four proxy slots with receipts and releases them on timeout and cancellation', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  fetchUpstream.mockImplementation(async (_, init: RequestInit) => {
    await consume(init);
    return new Promise((_, reject) => {
      if (init.signal?.aborted) reject(new Error('aborted'));
      else init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const receipt = () => post({ path: 'messages', signal: controller.signal, requestHeaders: new Headers({ ...headers,
    'Content-Type': workbookMediaType, [workbookFilenameHeader]: Buffer.from('synthetic.xlsx').toString('base64url') }) });
  const held = [receipt(), receipt(), receipt(), post({ signal: controller.signal })];
  expect((await post()).status).toBe(429);
  expect((await receipt()).status).toBe(429);
  controller.abort();
  expect((await Promise.all(held)).map(({ status }) => status)).toEqual([408, 408, 408, 408]);
  const last = post();
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await last).status).toBe(502);
});

it('rejects disabled draft and non-singleton headers before reading or forwarding the draft wire', async () => {
  const raw = Object.entries(draftHeaders).flat();
  for (const [status, flag, clarify, isQA, rawHeaders] of [
    [404, undefined, 'true', true, raw],
    [404, 'true', undefined, true, raw],
    [404, 'true', 'true', false, raw],
    [401, 'true', 'true', true, [...raw, 'authorization', 'Bearer another']],
    [400, 'true', 'true', true, [...raw, 'content-type', supplierDraftMediaType]],
    [400, 'true', 'true', true, [...raw, workbookFilenameHeader, 'ZXhhbXBsZS54bHN4']],
    [415, 'true', 'true', true, [...raw, 'content-encoding', 'identity']],
    [415, 'true', 'true', true, ['Authorization', headers.Authorization, 'Content-Type', `${supplierDraftMediaType}; charset=utf-8`]],
  ] as const) {
    vi.stubEnv('NEXT_PUBLIC_TEACH_DRAFT_LOCAL', flag);
    vi.stubEnv('NEXT_PUBLIC_TEACH_CLARIFY_LOCAL', clarify);
    qa.value = isQA;
    const req = Object.assign(new PassThrough(), { method: 'POST', url: pathname, rawHeaders });
    const read = vi.spyOn(req, 'read');
    const res = Object.assign(new PassThrough(), { statusCode: 0, headers: new Headers(),
      setHeader(name: string, value: string) { this.headers.set(name, value); },
      status(code: number) { this.statusCode = code; return this; } });
    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(read).not.toHaveBeenCalled();
    req.destroy(); res.destroy();
  }
  expect(fetchUpstream).not.toHaveBeenCalled();
});

it('selects the smaller draft budget by media type and preserves exact original chunks and canonical upstream headers', async () => {
  vi.stubEnv('NEXT_PUBLIC_TEACH_DRAFT_LOCAL', 'true');
  const slices = [Uint8Array.of(0, 0, 0, 3), Uint8Array.of(91, 49, 93), new Uint8Array(supplierDraftBodyLimit - 7)];
  const received: Uint8Array[] = [];
  fetchUpstream.mockImplementation(async (url, init) => {
    expect(url).toBe('http://qa.invalid/api/v1/teach-me/clarifications');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', duplex: 'half', cache: 'no-store', headers: draftHeaders });
    await consume(init, (bytes) => received.push(bytes));
    return Response.json(draftResult('B2'));
  });
  const requestHeaders = new Headers({ ...draftHeaders, 'Content-Type': supplierDraftMediaType.toUpperCase(),
    'Content-Length': '1', Cookie: 'unrelated=yes', 'X-Other': 'ignored' });
  const accepted = await post({ requestHeaders, body: stream(...slices) });
  expect(await accepted.json()).toEqual(draftResult('B2'));
  expect(accepted.headers.get('Cache-Control')).toBe('no-store');
  expect(received).toHaveLength(3);
  received.forEach((value, i) => expect(value).toBe(slices[i]));
  received.length = 0;
  const rejected = await post({ requestHeaders, body: stream(...slices, Uint8Array.of(1)) });
  expect(rejected.status).toBe(413);
  expect(rejected.headers.get('Cache-Control')).toBe('no-store');
  expect(received).toHaveLength(3);
});

it('requires closed draft-specific JSON variants, schema and content identity, and sanitizes errors', async () => {
  vi.stubEnv('NEXT_PUBLIC_TEACH_DRAFT_LOCAL', 'true');
  const { draft } = draftResult('B2');
  const result = (changed: unknown) => Response.json({ kind: 'draft', draft: changed });
  const requestHeaders = new Headers(draftHeaders);
  for (const [response, status] of [
    [Response.json(question), 200],
    [Response.json({ kind: 'not_applicable' }), 200],
    [Response.json({ kind: 'acknowledged' }), 502],
    [Response.json({ ...question, candidates: [question.candidates[0], { sheet: 'Tarifas', a1: 'D2' }] }), 502],
    [Response.json({ ...question, candidates: [{ sheet: 'Otra', a1: 'B2' }, question.candidates[1]] }), 502],
    [new Response('{', { headers: { 'Content-Type': 'application/json' } }), 502],
    [new Response(Uint8Array.of(0xc3, 0x28), { headers: { 'Content-Type': 'application/json' } }), 502],
    [new Response(`\ufeff${JSON.stringify(question)}`, { headers: { 'Content-Type': 'application/json' } }), 502],
    [new Response(`${' '.repeat(4096)}{}`, { headers: { 'Content-Type': 'application/json' } }), 502],
    [result({ ...draft, comment: 'extra' }), 502],
    [result({ ...draft, schemaVersion: 2 }), 502],
    [result({ ...draft, schemaVersion: '1' }), 502],
    [result({ ...draft, supplierKey: 'other' }), 502],
    [result({ ...draft, workbookSha256: 1 }), 502],
    [result({ ...draft, revisionId: '0'.repeat(64) }), 502],
    [result({ ...draft, rule: { ...draft.rule, value: 'extra' } }), 502],
    [result({ ...draft, rule: { ...draft.rule, header: { sheet: 'Tarifas', a1: 'B:B' } } }), 502],
    [new Response('private conflict', { status: 409 }), 409],
    [new Response('private failure', { status: 500 }), 502],
  ] as const) {
    fetchUpstream.mockImplementationOnce(async (_, init) => { await consume(init); return response; });
    const forwarded = await post({ requestHeaders });
    expect(forwarded.status).toBe(status);
    expect(forwarded.headers.get('Cache-Control')).toBe('no-store');
    if (status !== 200) expect(await forwarded.text()).toBe('');
  }
  fetchUpstream.mockImplementationOnce(async (_, init) => { await consume(init); return Response.json(draftResult('B2')); });
  expect((await post()).status).toBe(502); // A draft on the clarification wire is not a clarification.
});

it('shares time and concurrency budgets between draft and existing modes and releases the slots', async () => {
  vi.stubEnv('NEXT_PUBLIC_TEACH_DRAFT_LOCAL', 'true');
  vi.useFakeTimers();
  const controller = new AbortController();
  fetchUpstream.mockImplementation(async (_, init: RequestInit) => {
    await consume(init);
    return new Promise((_, reject) => {
      if (init.signal?.aborted) reject(new Error('aborted'));
      else init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const draft = (signal?: AbortSignal) => post({ signal, requestHeaders: new Headers(draftHeaders) });
  const held = [draft(controller.signal), post({ signal: controller.signal }), draft(controller.signal), post({ signal: controller.signal })];
  expect((await draft()).status).toBe(429);
  expect((await post()).status).toBe(429);
  controller.abort();
  expect((await Promise.all(held)).map(({ status }) => status)).toEqual([408, 408, 408, 408]);
  const last = draft();
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await last).status).toBe(502);
});

// Enabled only by the synthetic Netty test, which supplies its ephemeral port and in-memory fixtures.
it.skipIf(!process.env.BM_TEACH_CLARIFY_TEST_PORT)('chains actual Pages handler over HTTP to Ktor', async () => {
  const port = Number(process.env.BM_TEACH_CLARIFY_TEST_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback test port');
  vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
  vi.stubGlobal('fetch', realFetch);
  const server = createServer((req, res) => {
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } });
    void handler(req as NextApiRequest, response as unknown as NextApiResponse).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}${pathname}`;
    const workbook = Buffer.from(process.env.BM_TEACH_CLARIFY_TEST_WORKBOOK!, 'base64');
    const pdf = Buffer.from(process.env.BM_TEACH_CLARIFY_TEST_PDF!, 'base64');
    const png = Buffer.from(process.env.BM_TEACH_CLARIFY_TEST_PNG!, 'base64');
    const send = async (tuple: unknown[], ...parts: Buffer[]) => {
      const manifest = Buffer.from(JSON.stringify(tuple));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(manifest.length);
      const body = stream(prefix, manifest, ...parts);
      const response = await realFetch(upstream, { method: 'POST', body, duplex: 'half', headers } as RequestInit);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      return response.json();
    };
    const first = await send([1, 'ask', workbook.length], workbook);
    expect(first.kind).toBe('question');
    expect(first.candidates).toEqual(question.candidates);
    expect(await send([1, 'reply', workbook.length, pdf.length, png.length, first.workbookSha256, 'La columna C'], workbook, pdf, png))
      .toEqual({ kind: 'acknowledged' });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}, 25_000);

it.skipIf(!process.env.BM_TEACH_DRAFT_TEST_PORT)('chains supplier draft Pages proxy and Ktor over loopback', async () => {
  const port = Number(process.env.BM_TEACH_DRAFT_TEST_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback test port');
  vi.stubEnv('NEXT_PUBLIC_TEACH_DRAFT_LOCAL', 'true');
  vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
  vi.stubGlobal('fetch', realFetch);
  const server = createServer((req, res) => {
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } });
    void handler(req as NextApiRequest, response as unknown as NextApiResponse).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}${pathname}`;
    const workbook = Buffer.from(process.env.BM_TEACH_DRAFT_TEST_WORKBOOK!, 'base64');
    const digest = createHash('sha256').update(workbook).digest('hex');
    const send = async (tuple: unknown[], status = 200) => {
      const manifest = Buffer.from(JSON.stringify(tuple));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(manifest.length);
      const body = stream(prefix, manifest, workbook);
      const response = await realFetch(proxy, { method: 'POST', body, duplex: 'half', headers: draftHeaders } as RequestInit);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      return status === 200 ? response.json() : response.text();
    };
    expect(await send([1, 'ask', workbook.length])).toEqual({ ...question, workbookSha256: digest });
    const first = draftResult('B2', digest);
    const second = draftResult('C2', digest);
    expect(await send([1, 'draft', workbook.length, digest, 'demo-electricidad', 'La columna B'])).toEqual(first);
    expect(await send([1, 'revise', workbook.length, digest, 'demo-electricidad', '0'.repeat(64), 'La columna C'], 409)).toBe('');
    expect(await send([1, 'revise', workbook.length, digest, 'demo-electricidad', first.draft.revisionId, 'La columna C'])).toEqual(second);
    expect(second.draft.revisionId).not.toBe(first.draft.revisionId);
    expect(await send([1, 'revise', workbook.length, digest, 'demo-electricidad', second.draft.revisionId, 'La columna B'], 403)).toBe('');
  } finally {
    server.close();
    server.closeAllConnections();
  }
}, 25_000);
