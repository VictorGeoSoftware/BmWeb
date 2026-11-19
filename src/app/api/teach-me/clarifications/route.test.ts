// @vitest-environment node

import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import handler, { config } from '@/pages/api/teach-me/clarifications';
import { forwardTeachUpload } from '@/lib/teach-workbook-proxy';
import { clarificationBodyLimit, clarificationMediaType } from '@/lib/teach-clarification';
import { workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const qa = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/env', async (importOriginal) => process.env.BM_TEACH_CLARIFY_TEST_PORT
  ? importOriginal() : { get isQA() { return qa.value; } });

const pathname = '/api/teach-me/clarifications';
const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': clarificationMediaType };
const question = { kind: 'question', workbookSha256: 'a'.repeat(64), candidates: [{ sheet: 'Tarifas', a1: 'B2' }, { sheet: 'Tarifas', a1: 'C2' }] };
const fetchUpstream = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  qa.value = true;
  vi.stubGlobal('fetch', fetchUpstream.mockReset());
  vi.stubEnv('BM_BACKEND_URL', 'http://qa.invalid');
  vi.stubEnv('NEXT_PUBLIC_TEACH_CLARIFY_LOCAL', 'true');
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
