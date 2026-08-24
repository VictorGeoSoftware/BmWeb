import { NextRequest, NextResponse } from 'next/server';
import { authorizationHeader, MISSING_AUTH_RESPONSE } from '@/lib/backend-auth';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function DELETE(request: NextRequest) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(MISSING_AUTH_RESPONSE, { status: 401 });
  }

  try {
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(`${backendBaseUrl}/api/v1/clear-all-data`, {
      headers: { Authorization: authorization },
      method: 'DELETE',
    });

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message:
            (payload as { message?: string })?.message ??
            'Failed to clear all data',
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
