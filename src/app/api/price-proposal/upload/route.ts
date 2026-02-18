import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

export async function POST(request: NextRequest) {
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
