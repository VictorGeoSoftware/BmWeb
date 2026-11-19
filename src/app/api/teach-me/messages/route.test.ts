// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';
import { forwardTeachWorkbook } from '@/lib/teach-workbook-proxy';
import rawHandler, { config as rawConfig } from '@/pages/api/teach-me/messages';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const config = vi.hoisted(() => ({ isQA: true }));
vi.mock('@/lib/env', () => config);
const fetchUpstream = vi.fn();
const filename = 'Ejemplo español.XLSX';
const wire = Buffer.from(filename).toString('base64url');
const url = 'http://local.test/api/teach-me/messages';
const uploadHeaders = { Authorization: 'Bearer test', 'Content-Type': workbookMediaType, [workbookFilenameHeader]: wire };

function POST(request: NextRequest) {
  return forwardTeachWorkbook({ url: request.url, signal: request.signal, body: () => request.body,
    values: (key) => { const value = request.headers.get(key); return value === null ? [] : [value]; } });
}

async function rawRequest(rawHeaders: string[], stream = new PassThrough()) {
  const request = Object.assign(stream, { method: 'POST', url, rawHeaders });
  const output = Object.assign(new EventEmitter(), { headers: new Headers(), statusCode: 0, payload: undefined as string | undefined,
    setHeader(name: string, value: string) { this.headers.set(name, value); },
    status(code: number) { this.statusCode = code; return this; },
    end(value?: string) { this.payload = value; },
  });
  await rawHandler(request as unknown as NextApiRequest, output as unknown as NextApiResponse);
  return output;
}

function chunks(...lengths: number[]) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const length = lengths.shift();
      if (length === undefined) controller.close();
      else controller.enqueue(new Uint8Array(length).fill(17));
    },
  }, { highWaterMark: 0 });
}
function req({ body = chunks(3), headers = uploadHeaders as HeadersInit, address = url, signal }: {
  body?: ReadableStream<Uint8Array>; headers?: HeadersInit; address?: string; signal?: AbortSignal;
} = {}) {
  return new NextRequest(address, { method: 'POST', headers, body, duplex: 'half', signal });
}
async function consume(init: RequestInit, received: (bytes: Uint8Array) => void = () => {}) {
  const reader = (init.body as ReadableStream<Uint8Array>).getReader();
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return size;
      size += value.byteLength;
      received(value);
    }
  } finally { reader.releaseLock(); }
}

beforeEach(() => {
  config.isQA = true;
  vi.stubGlobal('fetch', fetchUpstream.mockReset());
  vi.stubEnv('BM_BACKEND_URL', 'http://qa.test');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('guards QA and bearer before pulling or forwarding', async () => {
  const pull = vi.fn();
  const body = () => new ReadableStream({ pull }, { highWaterMark: 0 });
  config.isQA = false;
  expect((await POST(req({ body: body() }))).status).toBe(404);
  config.isQA = true;
  expect((await POST(req({ body: body(), headers: {} }))).status).toBe(401);
  expect(pull).not.toHaveBeenCalled();
  expect(fetchUpstream).not.toHaveBeenCalled();
});

it('streams exact real budget, canonical headers only, and original bytes despite an inaccurate length', async () => {
  const counted = vi.fn((bytes: Uint8Array) => { expect(bytes[0]).toBe(17); expect(bytes.at(-1)).toBe(17); });
  fetchUpstream.mockImplementation(async (target, init) => {
    expect(target).toBe('http://qa.test/api/v1/teach-me/messages');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', duplex: 'half', cache: 'no-store', headers: uploadHeaders });
    expect(init.headers).toEqual(uploadHeaders);
    const sizeBytes = await consume(init, counted);
    return Response.json({ attachment: { kind: 'workbook', filename, sizeBytes } });
  });
  const response = await POST(req({ body: chunks(workbookBodyLimit - 1, 1), headers: {
    ...uploadHeaders, 'Content-Type': workbookMediaType.toUpperCase(), 'Content-Length': '1', Cookie: 'unrelated=yes', 'X-Other': 'ignored',
  } }));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ attachment: { kind: 'workbook', filename, sizeBytes: workbookBodyLimit } });
  expect(counted).toHaveBeenCalledTimes(2);
});

it('rejects first excess without forwarding it or draining and preserves the 413 from its own abort', async () => {
  const cancel = vi.fn();
  let pull = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    controller.enqueue(new Uint8Array(++pull === 1 ? workbookBodyLimit : 1));
  }, cancel }, { highWaterMark: 0 });
  let sent = 0;
  fetchUpstream.mockImplementation(async (_, init) => { await consume(init, (bytes) => sent += bytes.byteLength); });
  const response = await POST(req({ body }));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'upload_too_large' });
  expect(sent).toBe(workbookBodyLimit);
  expect(pull).toBe(2);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([
  undefined, `${wire}, ${wire}`, `${wire}=`, 'a', 'Zh', '_w', Buffer.from('\uFEFFa.xlsx').toString('base64url'),
  Buffer.from('a\u202Ex.xlsx').toString('base64url'), Buffer.from('a/b.xlsx').toString('base64url'),
  Buffer.from('.xlsx').toString('base64url'), Buffer.from(`${'a'.repeat(251)}.xlsx`).toString('base64url'),
])('rejects absent, duplicate or invalid name %s', async (value) => {
  const headers = new Headers(uploadHeaders);
  headers.delete(workbookFilenameHeader);
  if (value) headers.append(workbookFilenameHeader, value);
  expect((await POST(req({ headers }))).status).toBe(400);
  expect(fetchUpstream).not.toHaveBeenCalled();
});

it('rejects actual duplicate header appends, extra query, incorrect type/encoding and empty streamed body', async () => {
  const headers = new Headers(uploadHeaders);
  headers.append(workbookFilenameHeader, wire);
  expect((await POST(req({ headers }))).status).toBe(400);
  expect((await POST(req({ address: `${url}?comment=not-accepted` }))).status).toBe(400);
  expect((await POST(req({ headers: { ...uploadHeaders, 'Content-Type': `${workbookMediaType}, ${workbookMediaType}` } }))).status).toBe(400);
  expect((await POST(req({ headers: { ...uploadHeaders, 'Content-Type': `${workbookMediaType}; charset=utf-8` } }))).status).toBe(415);
  expect((await POST(req({ headers: { ...uploadHeaders, 'Content-Encoding': 'identity' } }))).status).toBe(415);
  expect(fetchUpstream).not.toHaveBeenCalled();
  fetchUpstream.mockImplementation(async (_, init) => { await consume(init); });
  expect((await POST(req({ body: chunks() }))).status).toBe(400);
});

it('rejects duplicate raw HTTP header lines even when one normalized value would appear valid', async () => {
  expect(rawConfig.api.bodyParser).toBe(false);
  const raw = Object.entries(uploadHeaders).flat();
  for (const [name, value] of [['content-type', workbookMediaType], [workbookFilenameHeader.toUpperCase(), wire]]) {
    const stream = new PassThrough();
    const read = vi.spyOn(stream, 'read');
    const response = await rawRequest([...raw, name, value], stream);
    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(response.headers.get('connection')).toBe('close');
    stream.destroy();
  }
  expect(fetchUpstream).not.toHaveBeenCalled();
});

it('reads the paused Node request in demand order and drops its length/framing headers', async () => {
  const source = new PassThrough();
  const chunks = [Buffer.from('ordinary '), Buffer.from('synthetic bytes')];
  const forwarded: Buffer[] = [];
  fetchUpstream.mockImplementation(async (_, init) => {
    expect(init.headers).toEqual(uploadHeaders);
    const sizeBytes = await consume(init, (bytes) => forwarded.push(Buffer.from(bytes)));
    return Response.json({ attachment: { kind: 'workbook', filename, sizeBytes } });
  });
  const result = rawRequest([...Object.entries(uploadHeaders).flat(), 'Transfer-Encoding', 'chunked'], source);
  source.write(chunks[0]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(Buffer.concat(forwarded)).toEqual(chunks[0]);
  source.end(chunks[1]);
  const response = await result;
  expect(Buffer.concat(forwarded)).toEqual(Buffer.concat(chunks));
  expect(response.statusCode).toBe(200);
  expect(source.listenerCount('readable')).toBe(0);
});

it.each([[401, 401], [403, 403], [404, 404], [408, 408], [413, 413], [415, 415], [429, 429], [201, 502], [302, 502], [500, 502]])(
  'returns upstream %i as %i without passing its body', async (status, expected) => {
    fetchUpstream.mockResolvedValue(new Response('internal upstream message', { status }));
    const response = await POST(req());
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain('internal upstream');
  });

it('fails closed on a malformed or mismatched 200 receipt', async () => {
  for (const payload of [null, { attachment: { kind: 'workbook', filename, sizeBytes: 4 } },
    { attachment: { kind: 'workbook', filename, sizeBytes: 3 }, text: 'not in contract' }]) {
    fetchUpstream.mockImplementation(async (_, init) => { await consume(init); return Response.json(payload); });
    expect((await POST(req())).status).toBe(502);
  }
});

it('times out a pending client read with 408 and frees the permit', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  fetchUpstream.mockImplementation(async (_, init) => { await consume(init); });
  const response = POST(req({ body: new ReadableStream({ pull: () => new Promise(() => {}), cancel }, { highWaterMark: 0 }) }));
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await response).status).toBe(408);
  expect(cancel).toHaveBeenCalledTimes(1);
  fetchUpstream.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await POST(req())).status).toBe(403);
});

it('returns 502 for an upstream timeout, bounds concurrency and frees slots after disconnect', async () => {
  vi.useFakeTimers();
  fetchUpstream.mockImplementation(async (_, init: RequestInit) => {
    await consume(init);
    return new Promise((_, reject) => {
      if (init.signal?.aborted) reject(new Error('aborted'));
      else init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = Array.from({ length: 4 }, () => POST(req({ signal: controller.signal })));
  expect((await POST(req())).status).toBe(429);
  expect(fetchUpstream).toHaveBeenCalledTimes(4);
  controller.abort();
  expect((await Promise.all(pending)).map((response) => response.status)).toEqual([408, 408, 408, 408]);
  const last = POST(req());
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await last).status).toBe(502);
});
