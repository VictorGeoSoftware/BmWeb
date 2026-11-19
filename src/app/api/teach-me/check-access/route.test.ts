// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';

const config = vi.hoisted(() => ({ isQA: true }));
vi.mock('@/lib/env', () => config);

const upstream = vi.fn();
const request = (authorization?: string) => new NextRequest('http://localhost/api/teach-me/check-access', {
  headers: authorization ? { Authorization: authorization, Cookie: 'unrelated=session' } : undefined,
});

beforeEach(() => {
  config.isQA = true;
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
  vi.stubEnv('BM_BACKEND_URL', 'http://qa.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('does not contact the backend outside QA or without a bearer token', async () => {
  config.isQA = false;
  expect((await GET(request('Bearer token'))).status).toBe(404);
  config.isQA = true;
  expect((await GET(request())).status).toBe(401);
  expect((await GET(request('Basic token'))).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

it('relays a grant without caching or forwarding unrelated headers', async () => {
  upstream.mockResolvedValue(new Response(null, { status: 204 }));
  const response = await GET(request('Bearer token'));
  expect(response.status).toBe(204);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(upstream).toHaveBeenCalledWith('http://qa.test/api/v1/teach-me/check-access', {
    cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer token' },
  });
});

it.each([[401, 401], [403, 403], [404, 404], [200, 502], [500, 502]])(
  'returns %i upstream as %i without sharing the response body', async (status, expected) => {
    upstream.mockResolvedValue(new Response('upstream details', { status }));
    const response = await GET(request('Bearer token'));
    expect(response.status).toBe(expected);
    expect(await response.text()).toBe('');
  }
);

it('fails closed on network errors', async () => {
  upstream.mockRejectedValue(new Error('offline'));
  expect((await GET(request('Bearer token'))).status).toBe(502);
});
