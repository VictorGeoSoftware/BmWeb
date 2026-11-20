'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { authFetch } from '@/lib/api-client';
import { promotionPath, promotionRefHeader, promotionResponseLimit, readPromotionResult } from '@/lib/teach-production-promotion';
import { readBoundedTeachJson, type ValidatableImportBatch } from '@/lib/teach-proposal-import';
import { useTeachImportRequest } from '@/lib/use-teach-import-request';

type Observation = NonNullable<ReturnType<typeof readPromotionResult>>;

export function TeachProductionPromotion({ user, canAccess, revoke, batch, validatedAt, fresh }: {
  user: User; canAccess: () => boolean; revoke: () => void; batch: ValidatableImportBatch; validatedAt: string; fresh: boolean;
}) {
  const { begin, cancel } = useTeachImportRequest(user, canAccess);
  const [dialog, setDialog] = useState(false);
  const [state, setState] = useState<'idle' | 'reading' | 'sending' | 'unknown'>('idle');
  const [seen, setSeen] = useState<Observation | null>(null);
  const [checkedWhileStale, setCheckedWhileStale] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const currentFresh = useRef(fresh);
  const busy = state === 'reading' || state === 'sending';
  const recover = seen?.kind === 'pending';
  const maySubmit = recover || (fresh && seen?.kind === 'notRequested');

  async function check(write: boolean) {
    if (write && (!dialog || !maySubmit)) return;
    const flight = begin();
    if (!flight) return;
    const opts = { signal: flight.signal, cache: 'no-store', redirect: 'error' } as const;
    let blocked = false;
    setDialog(false);
    setState(write ? 'sending' : 'reading');
    try {
      const response = await authFetch(promotionPath, write ? { ...opts, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validationRef: batch.validationRef, confirmPromotion: true }) }
        : { ...opts, headers: { [promotionRefHeader]: batch.validationRef } }, () => {
        blocked = write && !recover && !currentFresh.current;
        return flight.current() && !blocked;
      });
      if (!flight.current()) return;
      if ([401, 403].includes(response.status)) { setSeen(null); setState('idle'); revoke(); return; }
      if (!response.ok) throw new Error('Promotion state unavailable');
      const parsed = readPromotionResult(await readBoundedTeachJson(response, promotionResponseLimit), response.status, write);
      if (!flight.current()) return;
      if (!parsed || parsed.importId !== batch.importId || parsed.revisionId !== batch.revisionId ||
          parsed.generation !== batch.generation || parsed.validatedAt !== validatedAt) throw new Error('Wrong target');
      setSeen(parsed);
      setCheckedWhileStale(!currentFresh.current);
      setState('idle');
    } catch {
      if (flight.current()) { setSeen(null); setState(blocked ? 'idle' : 'unknown'); }
    } finally { flight.finish(); }
  }

  // The host keys this by exact evidence; the component also invalidates a replaced principal/target.
  useLayoutEffect(() => {
    setSeen(null); setDialog(false); setState('idle');
    void check(false);
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, batch.validationRef, batch.importId, batch.revisionId, batch.generation, validatedAt]);
  useLayoutEffect(() => {
    if (fresh) setCheckedWhileStale(false);
    currentFresh.current = fresh;
    if (!maySubmit) setDialog(false);
  }, [fresh, maySubmit]);

  const opened = state === 'idle' && seen?.kind === 'opened' && (fresh || checkedWhileStale) ? seen : null;
  return <section aria-label="Promoción simulada" className="space-y-2 [overflow-wrap:anywhere]">
    <p ref={notice} tabIndex={-1} role="status">{opened ? 'PR simulado abierto · no publicado'
      : busy ? (state === 'sending' ? 'Solicitando promoción simulada…' : 'Consultando esta solicitud…')
      : recover ? 'Solicitud pendiente de confirmación' : state === 'unknown' ? 'No se pudo confirmar la solicitud. Consulta esta importación de nuevo.'
      : seen?.kind === 'notRequested' ? 'Sin solicitud observada' : 'Estado de promoción no disponible'}</p>
    {opened && <p>Identificador copiable (no navegable): <code className="select-all" tabIndex={0} onFocus={event => {
      const range = document.createRange(); range.selectNodeContents(event.currentTarget);
      const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }}>{opened.url}</code></p>}
    <AlertDialog open={dialog && maySubmit} onOpenChange={open => { if (!open || (maySubmit && !busy && canAccess())) setDialog(open); }}>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} className="h-auto whitespace-normal" onClick={() => void check(false)}>Consultar promoción</Button>
        {maySubmit && <AlertDialogTrigger asChild><Button ref={trigger} type="button" aria-disabled={busy} className="h-auto whitespace-normal">
          {recover ? 'Recuperar esta solicitud' : 'Solicitar promoción a producción'}
        </Button></AlertDialogTrigger>}
      </div>
      <AlertDialogContent className="max-h-[90vh] w-[calc(100%-2rem)] overflow-auto [overflow-wrap:anywhere]"
        onCloseAutoFocus={event => { event.preventDefault(); (trigger.current ?? notice.current)?.focus(); }}>
        <AlertDialogTitle>{recover ? '¿Recuperar esta solicitud simulada?' : '¿Solicitar promoción a producción?'}</AlertDialogTitle>
        <AlertDialogDescription>
          Importación #{batch.importId} · {batch.supplierKey} · revisión <code>{batch.revisionId}</code> · generación {batch.generation}.
          Destino simulado: bm-pilot/skills-fixture · protected-fixture. No publica ni cambia producción.
        </AlertDialogDescription>
        <AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel>
          <Button type="button" onClick={() => void check(true)}>{recover ? 'Confirmar recuperación' : 'Confirmar solicitud simulada'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
