'use client';

import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { TeachWorkbookComposer } from '@/components/teach-workbook-composer';
import { TeachClarificationComposer } from '@/components/teach-clarification-composer';
import { TeachSupplierDraftComposer } from '@/components/teach-supplier-draft-composer';
import { TeachDraftPreview } from '@/components/teach-draft-preview';
import { Button } from '@/components/ui/button';
import { useTeachMeAccess } from '@/hooks/use-teach-me-access';
import { auth } from '@/lib/firebase/client';
import { isQA } from '@/lib/env';
import { isTeachClarificationEnabled } from '@/lib/teach-clarification';
import { isTeachSupplierDraftEnabled } from '@/lib/teach-supplier-draft';
import { isTeachDraftPreviewEnabled } from '@/lib/teach-draft-preview';

const unavailable = <p role="status">Esta sección no está disponible para tu cuenta en este entorno.</p>;

function TeachMeSession({ isCurrent }: { isCurrent: () => boolean }) {
  const access = useTeachMeAccess();
  const [denied, setDenied] = useState(false);
  const [pilotUnavailable, setPilotUnavailable] = useState(false);
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mode, setMode] = useState<'clarification' | 'draft' | null>(null);

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
      {isTeachDraftPreviewEnabled() && !previewUnavailable && <Button type="button" variant="outline" className="mt-3 h-auto max-w-full whitespace-normal text-left"
        aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>Probar previsualización (solo muestra Gesternova sintética)</Button>}
      <div className={previewOpen ? 'mt-4 grid min-w-0 items-start gap-4 lg:grid-cols-2' : undefined}>
        <div className="min-w-0">
          <TeachWorkbookComposer isCurrent={isCurrent} onDenied={() => setDenied(true)} />
          {isTeachClarificationEnabled() && !pilotUnavailable && <div className="mt-6 min-w-0 max-w-2xl space-y-3">
            <Button type="button" variant="outline" aria-expanded={mode === 'clarification'} className="h-auto max-w-full whitespace-normal text-left"
              onClick={() => setMode(mode === 'clarification' ? null : 'clarification')}>Probar aclaración (solo ejemplos sintéticos)</Button>
            {mode === 'clarification' && <TeachClarificationComposer isCurrent={isCurrent} onUnavailable={(status) => {
              setMode(null);
              setPilotUnavailable(true);
              if (status !== 404) setDenied(true);
            }} />}
          </div>}
          {isTeachSupplierDraftEnabled() && !draftUnavailable && <div className="mt-6 min-w-0 max-w-2xl space-y-3">
            <Button type="button" variant="outline" aria-expanded={mode === 'draft'} className="h-auto max-w-full whitespace-normal text-left"
              onClick={() => setMode(mode === 'draft' ? null : 'draft')}>Probar borrador de Skill (solo muestra sintética)</Button>
            {mode === 'draft' && <TeachSupplierDraftComposer isCurrent={isCurrent} onUnavailable={(status) => {
              setMode(null);
              setDraftUnavailable(true);
              if (status !== 404) setDenied(true);
            }} />}
          </div>}
        </div>
        {isTeachDraftPreviewEnabled() && previewOpen && !previewUnavailable && <TeachDraftPreview isCurrent={isCurrent} onUnavailable={(status) => {
          setPreviewOpen(false);
          setPreviewUnavailable(true);
          if (status !== 404) setDenied(true);
        }} />}
      </div>
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
