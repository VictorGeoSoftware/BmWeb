'use client';

import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/api-client';
import { draftPreviewFrame, draftPreviewMediaType, DraftSupplierSkillV2, previewProfile, readTeachDraftPreviewResult,
  samePreviewRevision, TeachPricePreview } from '@/lib/teach-draft-preview';
import { validWorkbookFilename, workbookBodyLimit } from '@/lib/teach-workbook';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { isTeachActivationPilotVisible, PilotPreview, qaPilotPreviewMediaType, readActivationResult, readPilotPreview } from '@/lib/teach-skill-activation';

const sendError = 'No se pudo completar la prueba. Puedes volver a intentarlo.';
const activationUnknown = 'No se pudo confirmar el resultado. Vuelve a previsualizar para comprobar la revisión activa';
const activationConflict = 'La prueba o la revisión activa ha cambiado. Vuelve a previsualizar y confirma de nuevo.';
const statusErrors: Record<number, string> = {
  400: 'No se pudo leer la solicitud. Vuelve a elegir la muestra aprobada.',
  409: 'La muestra o la revisión no coincide. Reselecciona el Excel sintético original o prepara el borrador de nuevo.',
  413: 'La solicitud supera los límites admitidos.',
  415: 'El servidor no admite ese Excel.',
};

function Citation({ from }: { from: { sheet: string; a1: string } }) {
  return <code>{from.sheet}!{from.a1}</code>;
}

export function TeachDraftPreview({ isCurrent, onUnavailable, activating, activationPending, setActivationPending }: {
  isCurrent: () => boolean;
  onUnavailable: (status: 401 | 403 | 404) => void;
  activating: boolean;
  activationPending: { readonly current: boolean };
  setActivationPending: (pending: boolean) => void;
}) {
  const [profile, setProfile] = useState('');
  const [file, setFile] = useState<File>();
  const [draft, setDraft] = useState<DraftSupplierSkillV2>();
  const [preview, setPreview] = useState<TeachPricePreview>();
  const [pilotProof, setPilotProof] = useState<PilotPreview>();
  const [active, setActive] = useState<PilotPreview['active']>();
  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [activationNotice, setActivationNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const failure = useRef<HTMLParagraphElement>(null);
  const pending = useRef<AbortController | null>(null);
  const pilot = isTeachActivationPilotVisible();
  const unexpired = (proof: PilotPreview) => Date.now() < proof.expiresAt * 1_000;

  function clearFile() {
    if (input.current) input.current.value = '';
    setFile(undefined);
  }

  function invalidate() {
    pending.current?.abort();
    pending.current = null;
    setSending(false);
    setError('');
    setPreview(undefined);
    setPilotProof(undefined);
    setActive(undefined);
    setExpired(false);
    setConfirming(false);
    if (activationPending.current) setActivationPending(false);
    setActivationNotice('');
  }

  function reset() {
    invalidate();
    clearFile();
    setProfile('');
    setDraft(undefined);
  }

  useLayoutEffect(() => {
    // Clear the rendered values before a browser can freeze this view into its back/forward cache.
    const onPageHide = () => flushSync(reset);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      pending.current?.abort();
      pending.current = null;
      if (activationPending.current) setActivationPending(false);
    };
  }, [activationPending, setActivationPending]);
  useLayoutEffect(() => { if (draft) summary.current?.focus(); }, [draft]);
  useLayoutEffect(() => { if (preview) summary.current?.focus(); }, [preview]);
  useLayoutEffect(() => { if (error) failure.current?.focus(); }, [error]);
  useLayoutEffect(() => { if (activationNotice) summary.current?.focus(); }, [activationNotice]);
  useLayoutEffect(() => { if (activating || expired) summary.current?.focus(); }, [activating, expired]);
  useEffect(() => {
    if (!pilotProof || activating) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (activationPending.current) return;
      const remaining = pilotProof.expiresAt * 1_000 - Date.now();
      if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 300_000));
      else { setExpired(true); setPilotProof(undefined); setConfirming(false); }
    };
    expire();
    return () => clearTimeout(timer);
  }, [pilotProof, activating, activationPending]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !isCurrent()) return;
    invalidate();
    if (profile !== previewProfile) { setError('Selecciona el perfil de Gesternova.'); return; }
    if (!file || !validWorkbookFilename(file.name) || file.size < 1 || file.size > workbookBodyLimit) {
      setError('Elige el Excel sintético original (.xlsx), de hasta 5 MiB.');
      return;
    }
    const request = new AbortController();
    pending.current = request;
    const current = () => pending.current === request && !request.signal.aborted && isCurrent();
    setError('');
    setSending(true);
    try {
      const body = draftPreviewFrame(file, draft);
      const pilotRun = pilot && draft !== undefined;
      if (!current()) return;
      const response = await authFetch('/api/teach-me/clarifications', {
        method: 'POST', cache: 'no-store', redirect: 'error', body, signal: request.signal,
        headers: { 'Content-Type': pilotRun ? qaPilotPreviewMediaType : draftPreviewMediaType },
      }, current);
      if (!current()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        reset();
        onUnavailable(response.status);
        return;
      }
      if (response.status !== 200) { setError(statusErrors[response.status] ?? sendError); return; }
      const payload: unknown = await response.json();
      if (!current()) return;
      if (pilotRun) {
        const proof = readPilotPreview(payload);
        if (!proof || !samePreviewRevision(draft, proof.preview)) throw new Error('Unexpected pilot preview response');
        setActive(proof.active);
        setPreview(proof.preview);
        if (unexpired(proof)) setPilotProof(proof); else setExpired(true);
      } else {
        const next = readTeachDraftPreviewResult(payload);
        if (!draft && next?.kind === 'draft' && next.draft.profileKey === profile) setDraft(next.draft);
        else if (draft && next?.kind === 'preview' && samePreviewRevision(draft, next)) setPreview(next);
        else throw new Error('Unexpected preview response');
      }
      clearFile();
    } catch {
      if (current()) setError(sendError);
    } finally {
      if (current()) setSending(false);
      if (pending.current === request) pending.current = null;
    }
  }

  async function activate() {
    if (!pilot || pending.current || !confirming || !draft || !pilotProof || !isCurrent() || !samePreviewRevision(draft, pilotProof.preview)) return;
    if (!unexpired(pilotProof)) { setExpired(true); setPilotProof(undefined); setConfirming(false); return; }
    const body = { revisionId: draft.revisionId, expectedRevisionId: pilotProof.active.revisionId,
      expectedGeneration: pilotProof.active.generation, receipt: pilotProof.receipt };
    const request = new AbortController();
    pending.current = request;
    // Lock same-view cancellation before React renders the disabled controls.
    setActivationPending(true);
    const current = () => pending.current === request && !request.signal.aborted && isCurrent();
    let dispatched = false;
    setPilotProof(undefined);
    setConfirming(false);
    setSending(true);
    setError('');
    try {
      const response = await authFetch('/api/teach-me/activation', {
        method: 'POST', cache: 'no-store', redirect: 'error', body: JSON.stringify(body), signal: request.signal,
        headers: { 'Content-Type': 'application/json' },
      }, () => {
        if (!current() || !unexpired(pilotProof)) return false;
        dispatched = true;
        return true;
      });
      if (!current()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        reset();
        onUnavailable(response.status);
        return;
      }
      if (response.status === 409) { setActive(undefined); setError(activationConflict); return; }
      if (response.status !== 200) throw new Error('Unconfirmed activation');
      const result = readActivationResult(await response.json(), body);
      if (!current()) return;
      if (!result) throw new Error('Unconfirmed activation');
      setActive(result.active);
      setActivationNotice(result.kind === 'alreadyActive' ? 'La revisión ya está activa en QA.' : 'Revisión activa en QA · piloto sintético.');
    } catch {
      if (current()) {
        if (dispatched) { setActive(undefined); setError(activationUnknown); }
        else if (!unexpired(pilotProof)) setExpired(true);
        else setError('No se pudo enviar la confirmación. Vuelve a previsualizar y confirma de nuevo.');
      }
    } finally {
      if (current()) setSending(false);
      if (pending.current === request) {
        pending.current = null;
        setActivationPending(false);
      }
    }
  }

  return <section aria-labelledby="teach-preview-title" className="min-w-0 space-y-3 rounded-md border p-3 [overflow-wrap:anywhere]">
    <h2 id="teach-preview-title" className="font-medium">Previsualización de precios</h2>
    {pilot && <p className="text-sm font-medium">QA · piloto sintético</p>}
    <p id="teach-preview-hint" className="text-sm text-muted-foreground">Usa solo <strong>gesternova-20td-sanitized.xlsx</strong> del repositorio de pruebas de BmBackend. Vuelve a elegir los mismos bytes en cada envío. {pilot ? 'Previsualizar no activa ni guarda propuestas.' : 'No se guarda ni se activa nada.'}</p>
    {draft && <div ref={summary} tabIndex={-1} aria-live="polite" className="space-y-2">
      <p>Gesternova · <strong>{pilot ? 'Revisión de la muestra' : 'Borrador sin activar'}</strong></p>
      <p>Revisión exacta: <code>{draft.revisionId}</code></p>
      {active && <p>Activa en QA: <code>{active.revisionId ?? 'Ninguna'}</code></p>}
      {active?.revisionId === draft.revisionId && !activationNotice && <p>Esta revisión ya está activa en QA.</p>}
      {activationNotice && <p role="status">{activationNotice}</p>}
      {preview && <>
        <p>Resultado de prueba · {preview.rows.length} propuestas fijas. Energía P2/P3 no consta en esta muestra.</p>
        <ul className="space-y-2">
          {preview.rows.map((row) => <li key={row.proposalCell.a1} className="space-y-1 rounded-md border p-2">
            <h3 className="font-medium">{row.proposal} · <Citation from={row.proposalCell} /></h3>
            <p>{row.tariff} · <Citation from={row.tariffCell} /></p>
            <p>{row.priceType} · <Citation from={row.typeCell} /></p>
            <ul className="space-y-1">
              {row.prices.map((price) => <li key={price.cell.a1}>
                {price.term === 'energy' ? 'Energía' : 'Potencia'} {price.period}: <strong>{price.decimal} {price.unit}</strong>
                <span className="block text-sm text-muted-foreground">Valor: <Citation from={price.cell} /> · Cabecera: <Citation from={price.header} /></span>
              </li>)}
            </ul>
          </li>)}
        </ul>
      </>}
    </div>}
    {expired && <p role="status">La prueba ha caducado. Vuelve a previsualizar para activar.</p>}
    {pilotProof && draft && <AlertDialog open={confirming} onOpenChange={(open) => {
      if (!activationPending.current) setConfirming(open);
    }}>
      <AlertDialogTrigger asChild><Button type="button" disabled={sending}>Activar en QA</Button></AlertDialogTrigger>
      <AlertDialogContent className="[overflow-wrap:anywhere]">
        <AlertDialogHeader>
          <AlertDialogTitle>Confirmar activación en QA</AlertDialogTitle>
          <AlertDialogDescription asChild><div>
            <p>QA · piloto sintético</p>
            <p>Nueva revisión: <code>{draft.revisionId}</code></p>
            <p>{pilotProof.active.revisionId === draft.revisionId ? 'Ya activa' : 'Revisión que se reemplaza'}: <code>{pilotProof.active.revisionId ?? 'Ninguna'}</code></p>
          </div></AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={activating}>Cancelar</AlertDialogCancel>
          <Button type="button" disabled={sending || expired} onClick={activate}>Confirmar revisión en QA</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
    <form onSubmit={submit} className="space-y-3">
      {!draft && <>
        <label htmlFor="teach-preview-profile" className="block text-sm font-medium">Perfil de la muestra</label>
        <select ref={select} id="teach-preview-profile" className="block max-w-full rounded-md border bg-background p-2" value={profile} disabled={activating}
          onChange={(event) => { if (!activationPending.current) { invalidate(); clearFile(); setProfile(event.target.value); } }}>
          <option value="">Selecciona un perfil</option>
          <option value={previewProfile}>Gesternova · 2.0TD (sintético)</option>
        </select>
      </>}
      <label htmlFor="teach-preview-file" className="block text-sm font-medium">{draft ? 'Reselecciona el mismo Excel (.xlsx)' : 'Excel sintético (.xlsx)'}</label>
      <input id="teach-preview-file" ref={input} type="file" accept=".xlsx" className="block max-w-full text-sm" aria-describedby="teach-preview-hint" disabled={activating}
        onChange={(event) => { if (!activationPending.current) { invalidate(); setFile(event.target.files?.[0]); } }} />
      {file && <div className="flex flex-wrap items-center gap-2">
        <span>Seleccionado: {file.name}</span>
        <Button type="button" variant="outline" disabled={activating} onClick={() => {
          if (!activationPending.current) { invalidate(); clearFile(); input.current?.focus(); }
        }}>Quitar Excel</Button>
      </div>}
      <Button type="submit" disabled={sending}>{draft ? 'Previsualizar precios' : 'Preparar borrador'}</Button>
      {sending && <p role="status">{activating ? 'Confirmando activación…' : draft ? 'Previsualizando…' : 'Preparando…'}</p>}
      {error && <p ref={failure} tabIndex={-1} role="alert" className="text-destructive">{error}</p>}
    </form>
    <Button type="button" variant="outline" disabled={activating} onClick={() => {
      if (activationPending.current) return;
      reset();
      if (draft) requestAnimationFrame(() => select.current?.focus()); else select.current?.focus();
    }}>
      {draft ? 'Preparar otra revisión' : 'Cancelar preparación'}
    </Button>
  </section>;
}
