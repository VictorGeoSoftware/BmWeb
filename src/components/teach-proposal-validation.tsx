'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { authFetch } from '@/lib/api-client';
import { importListResponseLimit, importsPath, importsQuery, readBoundedTeachJson, readImportPage,
  readValidationResult, validImportId, validationPath, validationResponseLimit, type ValidatableImportBatch } from '@/lib/teach-proposal-import';
import { useTeachImportRequest } from '@/lib/use-teach-import-request';
import { isTeachPromotionEnabled } from '@/lib/teach-production-promotion';
import { TeachProductionPromotion } from '@/components/teach-production-promotion';

const unknown = 'No se pudo confirmar el resultado. Vuelve a consultar esta importación';

export function TeachProposalValidation({ user, canAccess, revoke, batch, fresh }: {
  user: User; canAccess: () => boolean; revoke: () => void; batch: ValidatableImportBatch; fresh: boolean;
}) {
  const { begin } = useTeachImportRequest(user, canAccess);
  const [dialog, setDialog] = useState(false);
  const [state, setState] = useState<'idle' | 'pending' | 'checking' | 'unknown'>('idle');
  // Evidence here is hydrated only by an authorized read for this immutable target.
  const [observed, setObserved] = useState<ValidatableImportBatch['validation']>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refresh = useRef<HTMLButtonElement>(null);
  const evidence = batch.validation ?? observed;
  const busy = state === 'pending' || state === 'checking';
  const recovery = state === 'unknown' || state === 'checking';
  const mayConfirm = fresh || recovery;
  const currentFresh = useRef(fresh);
  useLayoutEffect(() => {
    currentFresh.current = fresh;
    if (!mayConfirm) setDialog(false);
  }, [fresh, mayConfirm]);

  async function check(confirm: boolean) {
    if ((confirm && (!dialog || !mayConfirm)) || evidence || !validImportId(batch.importId)) return;
    // The existing cursor is exclusive. Newer imports cannot push this target out of an anchored read.
    // The largest signed bigint cannot have a successor and is already first on the unbounded page.
    const cursor = batch.importId === '9223372036854775807' ? null : String(BigInt(batch.importId) + BigInt(1));
    const flight = begin(); // synchronous admission, including before acquiring the token
    if (!flight) return;
    const request = { signal: flight.signal, cache: 'no-store', redirect: 'error' } as const;
    const same = (value: { importId: string; revisionId: string; generation: string }) =>
      value.importId === batch.importId && value.revisionId === batch.revisionId && value.generation === batch.generation;
    setState(confirm ? 'pending' : 'checking');
    if (confirm) setDialog(false);
    let ordinaryConfirmationBlocked = false;
    try {
      let expected: string | undefined;
      if (confirm) {
        const result = await authFetch(validationPath, { ...request, method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ validationRef: batch.validationRef, confirmExpectedPrices: true }) }, () => {
          if (!flight.current()) return false;
          ordinaryConfirmationBlocked = !recovery && !currentFresh.current;
          return !ordinaryConfirmationBlocked;
        });
        if (!flight.current()) return;
        if ([401, 403].includes(result.status)) { revoke(); return; }
        if (!result.ok) throw new Error('Unconfirmed validation');
        const parsed = readValidationResult(await readBoundedTeachJson(result, validationResponseLimit), result.status);
        if (!flight.current()) return;
        if (!parsed || !same(parsed)) throw new Error('Unexpected validation response');
        expected = parsed.validatedAt;
      }
      const readback = await authFetch(importsPath + importsQuery(cursor, true), request, flight.current);
      if (!flight.current()) return;
      if ([401, 403, 404].includes(readback.status)) { revoke(); return; }
      if (!readback.ok) throw new Error('Validation list unavailable');
      const page = readImportPage(await readBoundedTeachJson(readback, importListResponseLimit), cursor, true);
      const target = page?.batches.find((row): row is ValidatableImportBatch =>
        'validationRef' in row && row.validationRef === batch.validationRef && same(row));
      if (!target?.validation || (expected && expected !== target.validation.validatedAt)) throw new Error('Validation not observed');
      if (flight.current()) {
        if ([trigger.current, refresh.current].includes(document.activeElement as HTMLButtonElement)) status.current?.focus();
        setObserved(target.validation);
        setState('idle');
      }
    } catch { if (flight.current()) setState(ordinaryConfirmationBlocked ? 'idle' : 'unknown'); }
    finally { flight.finish(); }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">QA · piloto sintético</p>
      <p ref={status} role="status" tabIndex={-1}>
        {evidence ? <>Resultado validado en QA{!fresh && !observed ? ' (consulta anterior)' : ''} · <time dateTime={evidence.validatedAt}>{evidence.validatedAt}</time></>
          : busy ? 'Consultando el resultado de esta importación…' : state === 'unknown' ? 'Validación aún no confirmada'
            : fresh ? 'Sin validar' : 'Estado de validación no actualizado'}
      </p>
      {!evidence && <>
        {state === 'unknown' && <p role="alert">{unknown}</p>}
        <AlertDialog open={dialog && mayConfirm} onOpenChange={open => { if (!open || (mayConfirm && !busy && canAccess())) setDialog(open); }}>
          <div className="flex flex-wrap gap-2">
            {mayConfirm && <AlertDialogTrigger asChild>
              <Button ref={trigger} type="button" className="h-auto whitespace-normal" aria-disabled={busy}>
                {recovery ? 'Volver a confirmar este resultado' : 'Validar resultado'}
              </Button>
            </AlertDialogTrigger>}
            {recovery && <Button ref={refresh} type="button" variant="outline" className="h-auto whitespace-normal"
              aria-disabled={busy} onClick={() => void check(false)}>Consultar esta importación</Button>}
          </div>
          <AlertDialogContent className="max-h-[90vh] w-[calc(100%-2rem)] overflow-auto [overflow-wrap:anywhere]"
            onCloseAutoFocus={event => { event.preventDefault(); (trigger.current ?? status.current)?.focus(); }}>
            <AlertDialogTitle>¿Validar el resultado de esta importación?</AlertDialogTitle>
            <AlertDialogDescription>
              QA · piloto sintético. Importación #{batch.importId} · {batch.supplierKey} · revisión <code>{batch.revisionId}</code> · generación {batch.generation}.
              Confirma solo después de comprobar los precios guardados de esta carga.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <Button type="button" className="h-auto whitespace-normal" onClick={() => void check(true)}>
                Confirmar que los precios guardados coinciden
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>}
      {evidence && isTeachPromotionEnabled() && <TeachProductionPromotion key={evidence.validatedAt}
        user={user} canAccess={canAccess} revoke={revoke} batch={batch} validatedAt={evidence.validatedAt} fresh={fresh} />}
    </div>
  );
}
