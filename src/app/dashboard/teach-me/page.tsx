'use client';

import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { TeachWorkbookComposer } from '@/components/teach-workbook-composer';
import { TeachClarificationComposer } from '@/components/teach-clarification-composer';
import { Button } from '@/components/ui/button';
import { useTeachMeAccess } from '@/hooks/use-teach-me-access';
import { auth } from '@/lib/firebase/client';
import { isQA } from '@/lib/env';
import { isTeachClarificationEnabled } from '@/lib/teach-clarification';

const unavailable = <p role="status">Esta sección no está disponible para tu cuenta en este entorno.</p>;

function TeachMeSession({ isCurrent }: { isCurrent: () => boolean }) {
  const access = useTeachMeAccess();
  const [denied, setDenied] = useState(false);
  const [pilotUnavailable, setPilotUnavailable] = useState(false);
  const [pilotOpen, setPilotOpen] = useState(false);

  if (denied || access === 'denied' || !isCurrent()) return unavailable;
  if (access === 'checking') return <p role="status">Comprobando acceso…</p>;
  if (access === 'error') return <p role="alert">No se pudo comprobar el acceso. Vuelve a intentarlo.</p>;

  return (
    <section aria-labelledby="teach-me-title">
      <div className="flex items-center gap-3">
        <h1 id="teach-me-title" className="font-headline text-2xl font-bold">Enséñame</h1>
        <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">QA</span>
      </div>
      <p className="mt-2 text-muted-foreground">Espacio para enseñar a BmWeb a leer propuestas de precios eléctricos en Excel.</p>
      <TeachWorkbookComposer isCurrent={isCurrent} onDenied={() => setDenied(true)} />
      {isTeachClarificationEnabled() && !pilotUnavailable && <div className="mt-6 min-w-0 max-w-2xl space-y-3">
        <Button type="button" variant="outline" aria-expanded={pilotOpen} className="h-auto whitespace-normal text-left"
          onClick={() => setPilotOpen(!pilotOpen)}>Probar aclaración (solo ejemplos sintéticos)</Button>
        {pilotOpen && <TeachClarificationComposer isCurrent={isCurrent} onUnavailable={(status) => {
          setPilotUnavailable(true);
          if (status !== 404) setDenied(true);
        }} />}
      </div>}
    </section>
  );
}

export default function TeachMePage() {
  const [session, setSession] = useState(() => ({ user: auth.currentUser, version: 0 }));
  const current = useRef<{ user: User | null; version: number }>(session);
  useEffect(() => {
    if (!isQA) return;
    return onAuthStateChanged(auth, (user) => {
      if (current.current.user === user) return;
      current.current = { user, version: current.current.version + 1 };
      setSession(current.current);
    });
  }, []);
  if (!isQA || !session.user) return unavailable;
  return <TeachMeSession key={session.version} isCurrent={() => current.current === session && auth.currentUser === session.user} />;
}
