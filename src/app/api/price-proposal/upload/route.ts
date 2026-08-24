import { NextRequest, NextResponse } from 'next/server';
import { authorizationHeader, MISSING_AUTH_RESPONSE } from '@/lib/backend-auth';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function POST(request: NextRequest) {
  const authorization = authorizationHeader(request);
  if (!authorization) {
    return NextResponse.json(MISSING_AUTH_RESPONSE, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { success: false, message: 'No PDF file provided.' },
        { status: 400 }
      );
    }

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json(
        { success: false, message: 'Only PDF files are accepted.' },
        { status: 400 }
      );
    }

    const backendFormData = new FormData();
    backendFormData.append('file', file, file.name);

    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const backendResponse = await fetch(`${backendBaseUrl}/api/v1/upload-price-proposal`, {
      method: 'POST',
      headers: { Authorization: authorization },
      body: backendFormData,
    });

    const responseText = await backendResponse.text();
    const responseJson = responseText ? JSON.parse(responseText) : {};

    return NextResponse.json(responseJson, {
      status: backendResponse.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json(
      {
        success: false,
        message: `Failed to upload price proposal: ${message}`,
      },
      { status: 500 }
    );
  }
}
