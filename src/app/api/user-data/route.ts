import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_BACKEND_URL = 'http://localhost:8081';

type UserDataPayload = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerIds: string[];
};

type SyncRequestBody = {
  idToken: string;
  userData: UserDataPayload;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<SyncRequestBody>;

    if (!body.idToken || !body.userData?.uid) {
      return NextResponse.json(
        { success: false, message: 'idToken and userData.uid are required.' },
        { status: 400 }
      );
    }

    const backendBaseUrl = process.env.BM_BACKEND_URL ?? DEFAULT_BACKEND_URL;
    const backendResponse = await fetch(`${backendBaseUrl}/api/v1/user-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${body.idToken}`,
      },
      body: JSON.stringify(body.userData),
    });

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text();
      return NextResponse.json(
        {
          success: false,
          message: errorText || 'Failed to sync user data with backend.',
        },
        { status: backendResponse.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
