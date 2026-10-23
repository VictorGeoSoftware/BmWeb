import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

function authorizationHeader(request: NextRequest): string | null {
  const header = request.headers.get('Authorization')?.trim();
  return header && header.startsWith('Bearer ') ? header : null;
}

function backendErrorMessage(payload: unknown, fallback: string): string {
  const body = payload as { message?: string; error?: string };
  return body?.message ?? body?.error ?? fallback;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(
      { success: false, message: 'Missing Authorization header' },
      { status: 401 }
    );
  }

  try {
    const { email } = await params;
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;

    const response = await fetch(
      `${backendBaseUrl}/api/v1/admin/granted-users/${encodeURIComponent(email)}`,
      {
        method: 'DELETE',
        headers: { Authorization: authorization },
      }
    );

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: backendErrorMessage(payload, 'Failed to delete granted user'),
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(
      { success: false, message: 'Missing Authorization header' },
      { status: 401 }
    );
  }

  try {
    const { email } = await params;
    const body = await request.json().catch(() => ({}));
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(
      `${backendBaseUrl}/api/v1/admin/granted-users/${encodeURIComponent(email)}/tier`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify({ tier: body?.tier ?? null }),
      }
    );

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};
    if (!response.ok) {
      return NextResponse.json(
        { success: false, message: backendErrorMessage(payload, 'Failed to update user tier') },
        { status: response.status }
      );
    }

    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
