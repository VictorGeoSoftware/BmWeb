'use client';

import { FormEvent, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/api-client';
import { draftPreviewFrame, draftPreviewMediaType, DraftSupplierSkillV2, previewProfile, readTeachDraftPreviewResult,
  samePreviewRevision, TeachPricePreview } from '@/lib/teach-draft-preview';
import { validWorkbookFilename, workbookBodyLimit } from '@/lib/teach-workbook';

const sendError = 'No se pudo completar la prueba. Puedes volver a intentarlo.';
const statusErrors: Record<number, string> = {
  400: 'No se pudo leer la solicitud. Vuelve a elegir la muestra aprobada.',
  409: 'La muestra o la revisión no coincide. Reselecciona el Excel sintético original o prepara el borrador de nuevo.',
  413: 'La solicitud supera los límites admitidos.',
  415: 'El servidor no admite ese Excel.',
};

function Citation({ from }: { from: { sheet: string; a1: string } }) {
  return <code>{from.sheet}!{from.a1}</code>;
}

export function TeachDraftPreview({ isCurrent, onUnavailable }: {
  isCurrent: () => boolean;
  onUnavailable: (status: 401 | 403 | 404) => void;
}) {
  const [profile, setProfile] = useState('');
  const [file, setFile] = useState<File>();
  const [draft, setDraft] = useState<DraftSupplierSkillV2>();
  const [preview, setPreview] = useState<TeachPricePreview>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const failure = useRef<HTMLParagraphElement>(null);
  const pending = useRef<AbortController | null>(null);

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
    };
  }, []);
  useLayoutEffect(() => { if (draft) summary.current?.focus(); }, [draft]);
  useLayoutEffect(() => { if (preview) summary.current?.focus(); }, [preview]);
  useLayoutEffect(() => { if (error) failure.current?.focus(); }, [error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !isCurrent()) return;
    setPreview(undefined);
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
      if (!current()) return;
      const response = await authFetch('/api/teach-me/clarifications', {
        method: 'POST', cache: 'no-store', redirect: 'error', body, signal: request.signal,
        headers: { 'Content-Type': draftPreviewMediaType },
      }, current);
      if (!current()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        reset();
        onUnavailable(response.status);
        return;
      }
      if (response.status !== 200) { setError(statusErrors[response.status] ?? sendError); return; }
      const next = readTeachDraftPreviewResult(await response.json());
      if (!current()) return;
      if (!draft && next?.kind === 'draft' && next.draft.profileKey === profile) setDraft(next.draft);
      else if (draft && next?.kind === 'preview' && samePreviewRevision(draft, next)) setPreview(next);
      else throw new Error('Unexpected preview response');
      clearFile();
    } catch {
      if (current()) setError(sendError);
    } finally {
      if (current()) setSending(false);
      if (pending.current === request) pending.current = null;
    }
  }

  return <section aria-labelledby="teach-preview-title" className="min-w-0 space-y-3 rounded-md border p-3 [overflow-wrap:anywhere]">
    <h2 id="teach-preview-title" className="font-medium">Previsualización de precios</h2>
    <p id="teach-preview-hint" className="text-sm text-muted-foreground">Usa solo <strong>gesternova-20td-sanitized.xlsx</strong> del repositorio de pruebas de BmBackend. Vuelve a elegir los mismos bytes en cada envío. No se guarda ni se activa nada.</p>
    {draft && <div ref={summary} tabIndex={-1} aria-live="polite" className="space-y-2">
      <p>Gesternova · <strong>Borrador sin activar</strong></p>
      <p>Revisión exacta: <code>{draft.revisionId}</code></p>
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
    <form onSubmit={submit} className="space-y-3">
      {!draft && <>
        <label htmlFor="teach-preview-profile" className="block text-sm font-medium">Perfil de la muestra</label>
        <select ref={select} id="teach-preview-profile" className="block max-w-full rounded-md border bg-background p-2" value={profile}
          onChange={(event) => { invalidate(); clearFile(); setProfile(event.target.value); }}>
          <option value="">Selecciona un perfil</option>
          <option value={previewProfile}>Gesternova · 2.0TD (sintético)</option>
        </select>
      </>}
      <label htmlFor="teach-preview-file" className="block text-sm font-medium">{draft ? 'Reselecciona el mismo Excel (.xlsx)' : 'Excel sintético (.xlsx)'}</label>
      <input id="teach-preview-file" ref={input} type="file" accept=".xlsx" className="block max-w-full text-sm" aria-describedby="teach-preview-hint"
        onChange={(event) => { invalidate(); setFile(event.target.files?.[0]); }} />
      {file && <div className="flex flex-wrap items-center gap-2">
        <span>Seleccionado: {file.name}</span>
        <Button type="button" variant="outline" onClick={() => { invalidate(); clearFile(); input.current?.focus(); }}>Quitar Excel</Button>
      </div>}
      <Button type="submit" disabled={sending}>{draft ? 'Previsualizar precios' : 'Preparar borrador'}</Button>
      {sending && <p role="status">{draft ? 'Previsualizando…' : 'Preparando…'}</p>}
      {error && <p ref={failure} tabIndex={-1} role="alert" className="text-destructive">{error}</p>}
    </form>
    <Button type="button" variant="outline" onClick={() => { reset(); if (draft) requestAnimationFrame(() => select.current?.focus()); else select.current?.focus(); }}>
      {draft ? 'Preparar otra revisión' : 'Cancelar preparación'}
    </Button>
  </section>;
}
