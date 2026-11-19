import { useLayoutEffect, useRef } from 'react';
import type { User } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

export function useTeachImportRequest(user: User, canAccess: () => boolean) {
  const active = useRef<AbortController | null>(null);
  function cancel() { active.current?.abort(); active.current = null; }
  useLayoutEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  function begin() {
    if (active.current || auth.currentUser !== user || !canAccess()) return null;
    const request = new AbortController();
    active.current = request;
    const current = () => active.current === request && !request.signal.aborted && auth.currentUser === user && canAccess();
    return { current, signal: request.signal, finish: () => { if (active.current === request) active.current = null; } };
  }
  return { begin, cancel };
}
