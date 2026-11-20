// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import activation, { config } from '@/pages/api/teach-me/activation';
import { handleTeachUpload } from '@/lib/teach-upload-handler';
import { forwardTeachUpload } from '@/lib/teach-workbook-proxy';
import { draftPreviewRevisionFields, draftPreviewMediaType, DraftSupplierSkillV2 } from '@/lib/teach-draft-preview';
import { pricePreviewFixture, previewDraftFixture } from '@/lib/teach-draft-preview.testing';
import { qaPilotPreviewMediaType, PilotPreview } from '@/lib/teach-skill-activation';

const qa = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/env', async (original) => process.env.BM_TEACH_ACTIVATION_TEST_PORT ? original() : { get isQA() { return qa.value; } });
const activationUrl = '/api/teach-me/activation';
const previewUrl = '/api/teach-me/clarifications';
const upstream = vi.fn();
const realFetch = globalThis.fetch;
const bearer = 'Bearer fixture-token';
const { draft } = previewDraftFixture;
const receipt = 'fake.' + 'x'.repeat(43);
const previous = { revisionId: null, generation: '0' };
const body = { revisionId: draft.revisionId, expectedRevisionId: null, expectedGeneration: '0', receipt };
const success = { kind: 'activated', active: { revisionId: body.revisionId, generation: '1' } };
const headers = (type = 'application/json') => ({ Authorization: bearer, 'Content-Type': type });

beforeEach(() => {
  qa.value = true;
  vi.stubGlobal('fetch', upstream.mockReset());
  for (const flag of ['CLARIFY', 'DRAFT', 'PREVIEW']) vi.stubEnv(`NEXT_PUBLIC_TEACH_${flag}_LOCAL`, 'true');
  vi.stubEnv('BM_TEACH_ACTIVATION_PILOT', 'true');
  vi.stubEnv('BM_BACKEND_URL', 'http://127.0.0.1:12345');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('uses an unparsed Pages POST and rejects forbidden modes, targets and raw headers without starting the request', async () => {
  expect(config.api.bodyParser).toBe(false);
  const raw = Object.entries(headers()).flat();
  const cases: [number, string, string, string[], () => void][] = [
    [405, 'GET', activationUrl, raw, () => {}],
    [404, 'POST', activationUrl, raw, () => { vi.stubEnv('BM_TEACH_ACTIVATION_PILOT', undefined); }],
    [404, 'POST', activationUrl, raw, () => { vi.stubEnv('NEXT_PUBLIC_TEACH_PREVIEW_LOCAL', undefined); }],
    [404, 'POST', activationUrl, raw, () => { qa.value = false; }],
    [400, 'POST', activationUrl + '?foo=bar', raw, () => {}],
    [400, 'POST', activationUrl, [...raw, 'content-type', 'application/json'], () => {}],
    [400, 'POST', activationUrl, [...raw, 'content-disposition', 'attachment'], () => {}],
    [401, 'POST', activationUrl, [...raw, 'authorization', bearer], () => {}],
    [415, 'POST', activationUrl, Object.entries(headers('application/json; charset=utf-8')).flat(), () => {}],
    [415, 'POST', activationUrl, [...raw, 'content-encoding', 'identity'], () => {}],
    ...['http://127.0.0.1', 'https://127.0.0.1:1', 'http://user@127.0.0.1:1', 'http://127.0.0.1:1/?x=1',
      'http://127.0.0.1:1/x', 'http://127.0.0.1:65536', 'http://localhost:1', 'http://127.0.0.1:1\n'].map(
      (target): [number, string, string, string[], () => void] => [502, 'POST', activationUrl, raw, () => vi.stubEnv('BM_BACKEND_URL', target)]),
  ];
  for (const [status, method, url, rawHeaders, configure] of cases) {
    qa.value = true;
    vi.stubEnv('BM_TEACH_ACTIVATION_PILOT', 'true');
    vi.stubEnv('NEXT_PUBLIC_TEACH_PREVIEW_LOCAL', 'true');
    configure();
    const req = Object.assign(new PassThrough(), { method, url, rawHeaders });
    const read = vi.spyOn(req, 'read');
    const res = Object.assign(new PassThrough(), { statusCode: 0, headers: new Headers(),
      setHeader(name: string, value: string) { this.headers.set(name, value); },
      status(code: number) { this.statusCode = code; return this; } });
    await activation(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    if (method === 'GET') expect(res.headers.get('allow')).toBe('POST');
    expect(read).not.toHaveBeenCalled();
    req.destroy(); res.destroy();
  }
  expect(upstream).not.toHaveBeenCalled();
});

function send(bytes: Uint8Array, path: 'activation' | 'clarifications', type: string = 'application/json') {
  const input = new Headers(headers(type));
  return forwardTeachUpload({ url: '/api/teach-me/' + path, signal: new AbortController().signal,
    body: () => new ReadableStream({ start(stream) { stream.enqueue(bytes); stream.close(); } }),
    values: (name) => input.has(name) ? [input.get(name)!] : [],
  }, path);
}

function frame(bytes: Uint8Array, selection: DraftSupplierSkillV2 = draft, mode = 'preview') {
  const manifest = Buffer.from(JSON.stringify([1, mode, bytes.length, selection.profileKey, ...(
    mode === 'preview' ? [selection.supplierKey, selection.workbookSha256, selection.revisionId] : [])]));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(manifest.length);
  return Buffer.concat([prefix, manifest, bytes]);
}

it('bounds requests and closes the success schema over the exact request and known preview registry', async () => {
  const respond = (response: Response) => upstream.mockImplementationOnce(async (_: string, init: RequestInit) => {
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', duplex: 'half', cache: 'no-store' });
    try { await new Response(init.body).arrayBuffer(); } catch { /* intentional over-limit */ }
    return response;
  });
  for (const [payload, code] of [[success, 200], [{ ...success, receipt }, 502], [{ ...success, kind: 'alreadyActive' }, 502],
    [{ ...success, active: { ...success.active, generation: '2' } }, 502],
    [{ ...success, active: { ...success.active, revisionId: 'f'.repeat(64) } }, 502]] as const) {
    respond(Response.json(payload));
    const response = await send(Buffer.from(JSON.stringify(body)), 'activation');
    expect(response.status).toBe(code);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  respond(Response.json(success));
  expect((await send(Buffer.alloc(2049), 'activation')).status).toBe(413);
  respond(new Response('private conflict', { status: 409 }));
  const conflict = await send(Buffer.from(JSON.stringify(body)), 'activation');
  expect(conflict.status).toBe(409);
  expect(await conflict.text()).toBe('');
  const envelope = { kind: 'qaPilotPreview', preview: pricePreviewFixture(), active: previous, expiresAt: 1800000300, receipt };
  for (const [payload, code] of [[envelope, 200], [{ ...envelope, active: { revisionId: 'f'.repeat(64), generation: '1' } }, 502],
    [{ ...envelope, preview: { ...envelope.preview, revisionId: 'f'.repeat(64) } }, 502],
    [{ ...envelope, expiresAt: 1.5 }, 502], [{ ...envelope, receipt: 'x'.repeat(1537) }, 502]] as const) {
    respond(Response.json(payload));
    expect((await send(frame(Buffer.from('synthetic')), 'clarifications', qaPilotPreviewMediaType)).status).toBe(code);
  }
});

it.skipIf(!process.env.BM_TEACH_ACTIVATION_TEST_PORT)('chains exact activation Pages proxy and Ktor over loopback', async () => {
  const port = Number(process.env.BM_TEACH_ACTIVATION_TEST_PORT);
  const offPort = Number(process.env.BM_TEACH_ACTIVATION_OFF_TEST_PORT);
  expect([port, offPort].every((n) => Number.isInteger(n) && n > 0 && n <= 65535)).toBe(true);
  vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
  vi.stubGlobal('fetch', realFetch);
  const samples = Array.from({ length: 3 }, (_, i) => {
    const bytes = Buffer.from(process.env[`BM_TEACH_ACTIVATION_TEST_BOOK_${i}`]!, 'base64');
    const workbookSha256 = createHash('sha256').update(bytes).digest('hex');
    const selection: DraftSupplierSkillV2 = { ...draft, workbookSha256 };
    selection.revisionId = createHash('sha256').update(draftPreviewRevisionFields(selection)).digest('hex');
    return { bytes, selection };
  });
  expect(samples[0].selection).toEqual(draft);
  const pins = new Set(samples.map(({ selection }) => selection.workbookSha256));
  expect(pins.size).toBe(3);
  let loseSuccess = false;
  const server = createServer((req, res) => {
    const isActivation = req.url === activationUrl;
    const end = res.end.bind(res);
    if (isActivation) res.end = ((...args: unknown[]) => {
      if (loseSuccess && res.statusCode === 200) { loseSuccess = false; res.destroy(); return res; }
      return Reflect.apply(end, res, args);
    }) as typeof res.end;
    const response = Object.assign(res, { status(code: number) { res.statusCode = code; return this; } }) as unknown as NextApiResponse;
    void (isActivation ? activation(req as NextApiRequest, response) : handleTeachUpload(req as NextApiRequest, response, 'clarifications', pins)).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: Buffer | string, type: string, auth = bearer) =>
      realFetch(root + path, { method: 'POST', body, headers: { ...headers(type), Authorization: auth }, redirect: 'error' });
    const request = async (path: string, body: Buffer | string, type: string, status: number, auth?: string) => {
      const response = await post(path, body, type, auth);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      return status === 200 ? JSON.parse(text) : null;
    };
    const comparison = (i: number) => frame(samples[i].bytes, samples[i].selection);
    const inspect = async (i: number): Promise<PilotPreview> => {
      const result = await request(previewUrl, comparison(i), qaPilotPreviewMediaType, 200) as PilotPreview;
      const { workbookSha256, revisionId } = samples[i].selection;
      const oracle = { ...pricePreviewFixture(), workbookSha256, revisionId };
      oracle.rows[0].prices[0].decimal = ['0.12125', '0.13125', '0.14125'][i];
      expect(result.preview).toEqual(oracle);
      expect(result.expiresAt).toBe(1800000300);
      return result;
    };
    const confirm = ({ preview, active, receipt }: PilotPreview) => JSON.stringify({ revisionId: preview.revisionId,
      expectedRevisionId: active.revisionId, expectedGeneration: active.generation, receipt });
    const revisions = samples.map(({ selection }) => selection.revisionId);
    const before = await inspect(1);
    expect(before.active).toEqual({ revisionId: revisions[0], generation: '1' });
    const first = confirm(before);
    await request(activationUrl, first, 'application/json', 401, 'Bearer invalid');
    await request(previewUrl, comparison(1), qaPilotPreviewMediaType, 401, 'Bearer invalid');
    await request(previewUrl, frame(samples[0].bytes, draft, 'prepare'), qaPilotPreviewMediaType, 400);
    await request(previewUrl, frame(samples[0].bytes, draft, 'prepare'), draftPreviewMediaType, 200);
    await request(previewUrl, frame(samples[2].bytes, samples[1].selection), qaPilotPreviewMediaType, 409);
    vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${offPort}`);
    await request(activationUrl, first, 'application/json', 404);
    await request(previewUrl, comparison(1), qaPilotPreviewMediaType, 404);
    vi.stubEnv('BM_BACKEND_URL', `http://127.0.0.1:${port}`);
    loseSuccess = true;
    await expect(post(activationUrl, first, 'application/json')).rejects.toThrow();
    const after = await inspect(1);
    expect(after.active).toEqual({ revisionId: revisions[1], generation: '2' });
    await request(activationUrl, first, 'application/json', 409);
    expect(await request(activationUrl, confirm(after), 'application/json', 200)).toEqual({ kind: 'alreadyActive', active: after.active });
    const back = await inspect(0);
    expect(await request(activationUrl, confirm(back), 'application/json', 200)).toEqual({ kind: 'activated', active: { revisionId: revisions[0], generation: '3' } });
    const [left, right] = await Promise.all([inspect(1), inspect(2)]);
    expect(left.active).toEqual(right.active);
    const raced = await Promise.all([left, right].map((proof) => post(activationUrl, confirm(proof), 'application/json')));
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    const winning = raced[0].status === 200 ? 1 : 2;
    expect(await raced[winning - 1].json()).toEqual({ kind: 'activated', active: { revisionId: revisions[winning], generation: '4' } });
    await raced[2 - winning].arrayBuffer();
    expect((await inspect(0)).active).toEqual({ revisionId: revisions[winning], generation: '4' });
  } finally { server.close(); server.closeAllConnections(); }
}, 25_000);
