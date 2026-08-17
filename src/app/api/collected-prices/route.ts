import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

/**
 * Extracts the Firebase ID token sent by the dashboard client. The backend
 * verifies it and checks the caller is on the admin allowlist.
 */
function authorizationHeader(request: NextRequest): string | null {
  const header = request.headers.get('Authorization')?.trim();
  return header && header.startsWith('Bearer ') ? header : null;
}

/** Backend errors arrive as {"message": ...} (routes) or {"error": ...} (StatusPages). */
function backendErrorMessage(payload: unknown, fallback: string): string {
  const body = payload as { message?: string; error?: string };
  return body?.message ?? body?.error ?? fallback;
}

/** Only forwards the filters the backend understands, so nothing else leaks through. */
function backendQuery(request: NextRequest): string {
  const incoming = request.nextUrl.searchParams;
  const forwarded = new URLSearchParams();

  (['limit', 'offset', 'tariffType', 'companyName'] as const).forEach(key => {
    const value = incoming.get(key);
    if (value !== null && value.trim() !== '') {
      forwarded.set(key, value);
    }
  });

  const query = forwarded.toString();
  return query ? `?${query}` : '';
}

export async function GET(request: NextRequest) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(
      { success: false, message: 'Missing Authorization header' },
      { status: 401 }
    );
  }

  try {
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(
      `${backendBaseUrl}/api/v1/admin/collected-prices${backendQuery(request)}`,
      {
        cache: 'no-store',
        headers: { Authorization: authorization },
      }
    );

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: backendErrorMessage(payload, 'Failed to fetch collected prices'),
        },
        { status: response.status }
      );
    }

    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
