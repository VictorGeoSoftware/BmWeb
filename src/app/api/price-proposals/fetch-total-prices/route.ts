import { NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function POST() {
  try {
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(`${backendBaseUrl}/api/v1/fetch-total-prices`, {
      method: 'POST',
    });

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message:
            (payload as { message?: string })?.message ??
            'Failed to trigger Total prices workflow',
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
