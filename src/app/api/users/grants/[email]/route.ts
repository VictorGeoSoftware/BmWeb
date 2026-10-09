import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  const authorization = request.headers.get('Authorization')?.trim();
  if (!authorization || !authorization.startsWith('Bearer ')) {
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
          message:
            (payload as { message?: string; error?: string })?.message ??
            (payload as { error?: string })?.error ??
            'Failed to delete granted user',
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
