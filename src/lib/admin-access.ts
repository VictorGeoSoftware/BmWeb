import { auth } from '@/lib/firebase/client';

export type AdminAccessResult = 'granted' | 'denied' | 'error';

/**
 * Asks the backend whether the currently signed-in Firebase account is on the
 * admin allowlist. Returns 'error' when the check could not be performed
 * (network/backend failure) so callers can decide how strict to be.
 */
export async function checkAdminAccess(): Promise<AdminAccessResult> {
  const user = auth.currentUser;
  if (!user) return 'denied';

  const idToken = await user.getIdToken();

  try {
    const response = await fetch('/api/admin/check-access', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (response.status === 401 || response.status === 403) return 'denied';
    if (!response.ok) return 'error';

    const payload = (await response.json()) as { success?: boolean };
    return payload?.success === true ? 'granted' : 'denied';
  } catch {
    return 'error';
  }
}
