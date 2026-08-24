import { NextRequest, NextResponse } from 'next/server';
import { authorizationHeader, MISSING_AUTH_RESPONSE } from '@/lib/backend-auth';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function GET(request: NextRequest) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(MISSING_AUTH_RESPONSE, { status: 401 });
  }

  try {
    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(`${backendBaseUrl}/api/v1/price-table-results`, {
      cache: 'no-store',
      headers: { Authorization: authorization },
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

export async function PATCH(request: NextRequest) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(MISSING_AUTH_RESPONSE, { status: 401 });
  }

  try {
    const body = (await request.json()) as {
      iva?: unknown;
      impuestoElectrico?: unknown;
    };

    const iva = Number(body?.iva);
    const impuestoElectrico = Number(body?.impuestoElectrico);

    if (!Number.isFinite(iva) || iva < 0 || !Number.isFinite(impuestoElectrico) || impuestoElectrico < 0) {
      return NextResponse.json(
        {
          success: false,
          message: 'iva and impuestoElectrico must be numbers greater than or equal to 0',
        },
        { status: 400 }
      );
    }

    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(`${backendBaseUrl}/api/v1/price-table-tax-settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({ iva, impuestoElectrico }),
    });

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message:
            (payload as { message?: string })?.message ??
            'Failed to update tax settings',
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

export async function DELETE(request: NextRequest) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(MISSING_AUTH_RESPONSE, { status: 401 });
  }

  try {
    const body = (await request.json()) as { ids?: unknown };
    const ids = Array.isArray(body?.ids) ? body.ids : [];

    if (ids.length === 0 || ids.some(id => !Number.isInteger(id) || Number(id) <= 0)) {
      return NextResponse.json(
        {
          success: false,
          message: 'ids must be a non-empty array of positive integers',
        },
        { status: 400 }
      );
    }

    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const response = await fetch(`${backendBaseUrl}/api/v1/price-table-results`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({ ids }),
    });

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message:
            (payload as { message?: string })?.message ??
            'Failed to delete selected price proposals',
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
