"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { checkAdminAccess } from '@/lib/admin-access';

type AuthGuardProps = {
  children: React.ReactNode;
};

export default function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setIsAuthenticated(false);
        setIsCheckingAuth(false);
        router.replace('/');
        return;
      }

      // BmWeb is admin-only: drop sessions whose account is not on the
      // backend admin allowlist (e.g. access revoked while logged in).
      // On verification errors the session is kept so a backend outage
      // does not kick admins out.
      void checkAdminAccess().then(async (result) => {
        if (result === 'denied') {
          await signOut(auth);
          setIsAuthenticated(false);
          setIsCheckingAuth(false);
          router.replace('/');
          return;
        }
        setIsAuthenticated(true);
        setIsCheckingAuth(false);
      });
    });

    return () => unsubscribe();
  }, [router]);

  if (isCheckingAuth) {
    return (
      <div className="flex min-h-[200px] items-center justify-center text-sm text-muted-foreground">
        Checking session...
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
