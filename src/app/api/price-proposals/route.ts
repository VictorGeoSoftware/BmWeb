import { NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function GET() {
  try {
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(`${backendBaseUrl}/api/v1/price-table-results`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json(
        { success: false, message: text || 'Failed to fetch price proposals' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
