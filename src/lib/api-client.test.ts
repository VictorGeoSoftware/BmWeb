// @vitest-environment node

/**
 * Tests for the authenticated `fetch` wrapper.
 *
 * Every browser call to the price-table endpoints goes through here, so this is
 * the single place that guarantees a Firebase ID token is attached. A regression
 * would not fail loudly in the UI — it would surface as a confusing 401 from the
 * backend — which is exactly why it is worth pinning down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real module initialises a Firebase app at import time. The mock stands in
// for the auth singleton so tests can control who is signed in.
const { authMock } = vi.hoisted(() => ({
  authMock: { currentUser: null as { getIdToken: () => Promise<string> } | null },
}));
vi.mock('@/lib/firebase/client', () => ({ auth: authMock }));

import { authFetch } from '@/lib/api-client';

const signedIn = (token = 'id-token-123') => {
  authMock.currentUser = { getIdToken: vi.fn().mockResolvedValue(token) };
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.currentUser = null;
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authFetch', () => {
  it('refuses to send an anonymous request', async () => {
    await expect(authFetch('/api/price-proposals')).rejects.toThrow(
      'You must be signed in to perform this action.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches the current user ID token as a Bearer header', async () => {
    signedIn('a-fresh-token');

    await authFetch('/api/price-proposals');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/price-proposals');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer a-fresh-token');
  });

  it('requests a token per call, so an expired one is refreshed', async () => {
    signedIn();

    await authFetch('/api/price-proposals');
    await authFetch('/api/price-proposals');

    expect(authMock.currentUser!.getIdToken).toHaveBeenCalledTimes(2);
  });

  it('keeps caller headers alongside the injected Authorization header', async () => {
    signedIn();

    await authFetch('/api/price-proposals', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2] }),
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer id-token-123');
    expect(init.method).toBe('DELETE');
  });

  it('forwards the rest of the init untouched, including the abort signal', async () => {
    // Bulk upload cancellation depends on the signal surviving this wrapper.
    signedIn();
    const controller = new AbortController();
    const body = new FormData();

    await authFetch('/api/price-proposal/upload', {
      method: 'POST',
      body,
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
    expect(init.body).toBe(body);
  });

  it('returns the response as-is, without inspecting the status', async () => {
    // Callers decide what a non-2xx means; the wrapper must not throw on it.
    signedIn();
    const backendResponse = new Response('{"success":false}', { status: 500 });
    fetchMock.mockResolvedValue(backendResponse);

    await expect(authFetch('/api/price-proposals')).resolves.toBe(backendResponse);
  });
});
