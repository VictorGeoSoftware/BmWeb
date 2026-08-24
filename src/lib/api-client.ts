import { auth } from '@/lib/firebase/client';

/**
 * `fetch` wrapper that attaches the signed-in user's Firebase ID token.
 *
 * The price-table endpoints used to be reachable with no credentials at all.
 * They now require authentication (and admin rights for the destructive ones),
 * so every browser call must carry a token. Centralised here so a new call site
 * cannot silently forget it.
 *
 * Throws when nobody is signed in, rather than sending an anonymous request
 * that would fail server-side with a less obvious error.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You must be signed in to perform this action.');
  }

  const idToken = await user.getIdToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${idToken}`);

  return fetch(input, { ...init, headers });
}
