import { NextRequest, NextResponse } from 'next/server';
import { authorizationHeader } from '@/lib/backend-auth';
import { isQA } from '@/lib/env';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  if (!isQA) return new NextResponse(null, { status: 404, headers });

  const authorization = authorizationHeader(request);
  if (!authorization) return new NextResponse(null, { status: 401, headers });

  try {
    const backend = process.env.BM_BACKEND_URL ?? 'http://localhost:8081';
    const { status } = await fetch(`${backend}/api/v1/teach-me/check-access`, {
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: authorization },
    });

    return new NextResponse(null, { status: [204, 401, 403, 404].includes(status) ? status : 502, headers });
  } catch {
    return new NextResponse(null, { status: 502, headers });
  }
}
