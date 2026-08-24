import { NextRequest } from 'next/server';

/**
 * Extracts the Firebase ID token forwarded by the dashboard client.
 *
 * The backend verifies the token and checks the caller is granted (and, for
 * most price-table operations, an admin). Route handlers must reject the
 * request themselves when this returns null — the backend would too, but
 * failing here avoids a pointless round trip and returns a clearer error.
 */
export function authorizationHeader(request: NextRequest): string | null {
  const header = request.headers.get('Authorization')?.trim();
  return header && header.startsWith('Bearer ') ? header : null;
}

/** Standard 401 body for a missing or malformed Authorization header. */
export const MISSING_AUTH_RESPONSE = {
  success: false,
  message: 'Missing Authorization header',
} as const;
