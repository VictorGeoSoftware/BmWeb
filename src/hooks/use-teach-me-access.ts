'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/api-client';
import { isQA } from '@/lib/env';

type Access = 'checking' | 'granted' | 'denied' | 'error';

export function useTeachMeAccess(path?: string): Access {
  const [check, setCheck] = useState<{ path?: string; access: Access }>({ access: 'checking' });

  useEffect(() => {
    if (!isQA) return;
    const request = new AbortController();

    setCheck({ path, access: 'checking' });
    void authFetch('/api/teach-me/check-access', { cache: 'no-store', signal: request.signal })
      .then(({ status }) => {
        if (request.signal.aborted) return;
        const access = status === 204 ? 'granted' : [401, 403, 404].includes(status) ? 'denied' : 'error';
        setCheck({ path, access });
      })
      .catch(() => {
        if (!request.signal.aborted) setCheck({ path, access: 'error' });
      });

    return () => request.abort();
  }, [path]);

  if (!isQA) return 'denied';
  return check.path === path ? check.access : 'checking';
}
