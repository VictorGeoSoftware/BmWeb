'use client';

import { FormEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/api-client';
import { demoSupplier, demoWorkbookName, DraftSupplierSkillV1, readSupplierDraftResult, supplierDraftAnswer,
  supplierDraftFrame, supplierDraftMediaType, SupplierDraftQuestion } from '@/lib/teach-supplier-draft';
import { workbookBodyLimit } from '@/lib/teach-workbook';

type Phase = { kind: 'ask' } | { kind: 'not_applicable' } | SupplierDraftQuestion |
  { kind: 'draft'; question: SupplierDraftQuestion; current: DraftSupplierSkillV1; previous?: DraftSupplierSkillV1 };

const sendError = 'No se pudo confirmar el envío. Puedes volver a intentarlo.';
const statusErrors: Record<number, string> = {
  400: 'Revisa la comercializadora y la selección de columna.',
  409: 'La muestra o la revisión no coincide. Vuelve a elegir el Excel sintético original.',
  413: 'La solicitud supera los límites admitidos.',
  415: 'El servidor no admite ese Excel.',
};

function DraftSummary({ label, draft }: { label: string; draft: DraftSupplierSkillV1 }) {
  const { sheet, a1 } = draft.rule.header;
  return <div className="min-w-0 rounded-md border p-2">
    <h4 className="font-medium">{label}</h4>
    <p>Comercializadora Demo · Borrador sin activar</p>
    <p>Columna de precio fijo: <strong>{sheet}!{a1}</strong></p>
    <p>Identificador de revisión: <code className="[overflow-wrap:anywhere]">{draft.revisionId}</code></p>
  </div>;
}

export function TeachSupplierDraftComposer({ isCurrent, onUnavailable }: {
  isCurrent: () => boolean;
  onUnavailable: (status: 401 | 403 | 404) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });
  const [file, setFile] = useState<File>();
  const [supplier, setSupplier] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const pending = useRef<AbortController | null>(null);
  const question = phase.kind === 'draft' ? phase.question : phase.kind === 'question' ? phase : undefined;
  const prior = phase.kind === 'draft' ? phase.current : undefined;
  const canSend = phase.kind === 'ask' || phase.kind === 'question' || (phase.kind === 'draft' && !phase.previous);

  function clearFile() {
    if (input.current) input.current.value = '';
    setFile(undefined);
  }

  function reset() {
    pending.current?.abort();
    pending.current = null;
    clearFile();
    setSupplier('');
    setAnswer('');
    setError('');
    setSending(false);
    setPhase({ kind: 'ask' });
  }

  useLayoutEffect(() => {
    window.addEventListener('pagehide', reset);
    return () => {
      window.removeEventListener('pagehide', reset);
      pending.current?.abort();
      pending.current = null;
      if (input.current) input.current.value = '';
    };
  }, []);

  useLayoutEffect(() => { if (phase.kind !== 'ask') result.current?.focus(); }, [phase]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend || pending.current || !isCurrent()) return;
    if (!file || file.size < 1 || file.size > workbookBodyLimit) {
      setError('Elige el Excel sintético original, de hasta 5 MiB.');
      return;
    }
    if (question && supplier !== demoSupplier) { setError('Selecciona Comercializadora Demo.'); return; }
    const choice = question ? supplierDraftAnswer(answer) : null;
    if (question && !choice) { setError('Escribe «La columna B» o «La columna C».'); return; }
    if (choice && prior?.rule.header.a1 === choice.a1) { setError('Para corregir el borrador, elige la otra columna.'); return; }
    const request = new AbortController();
    pending.current = request;
    const current = () => pending.current === request && !request.signal.aborted && isCurrent();
    setError('');
    setSending(true);
    try {
      const body = supplierDraftFrame(file, question && choice ? { question, supplierKey: demoSupplier, answer, prior } : undefined);
      const response = await authFetch('/api/teach-me/clarifications', {
        method: 'POST', cache: 'no-store', redirect: 'error', body, signal: request.signal,
        headers: { 'Content-Type': supplierDraftMediaType },
      }, current);
      if (!current()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        reset();
        onUnavailable(response.status);
        return;
      }
      if (response.status !== 200) { setError(statusErrors[response.status] ?? sendError); return; }
      const next = readSupplierDraftResult(await response.json());
      if (!current()) return;
      if (!next) throw new Error('Invalid supplier draft result');
      if (next.kind === 'draft' && question && choice) {
        const { draft } = next;
        const { sheet, a1 } = draft.rule.header;
        if (draft.supplierKey !== supplier || draft.workbookSha256 !== question.workbookSha256 || a1 !== choice.a1 ||
            !question.candidates.some((cite) => cite.sheet === sheet && cite.a1 === a1) ||
            (prior && (draft.revisionId === prior.revisionId || draft.rule.header.a1 === prior.rule.header.a1))) {
          throw new Error('Unexpected supplier draft revision');
        }
        setPhase({ kind: 'draft', question, current: draft, previous: prior });
      } else if (phase.kind === 'ask' && next.kind !== 'draft') {
        setPhase(next);
      } else throw new Error('Unexpected supplier draft phase');
      clearFile();
      setSupplier('');
      setAnswer('');
    } catch {
      if (current()) setError(sendError);
    } finally {
      if (current()) setSending(false);
      if (pending.current === request) pending.current = null;
    }
  }

  return <section aria-label="Borrador de Skill de ejemplo" className="min-w-0 space-y-3 rounded-md border p-3 [overflow-wrap:anywhere]">
    <p className="text-sm text-muted-foreground" id="draft-hint">Usa solo la muestra sintética <strong>{demoWorkbookName}</strong> del repositorio de pruebas de BmBackend. Vuelve a elegirla en cada envío. No se guarda ni se activa ninguna regla.</p>
    <div className="min-w-0 space-y-2" tabIndex={phase.kind === 'ask' ? undefined : -1} ref={result} aria-live="polite">
      {phase.kind === 'question' && <p>¿Cuál de las dos columnas de precio fijo debo usar: ‹{phase.candidates[0].sheet}!{phase.candidates[0].a1}› o ‹{phase.candidates[1].sheet}!{phase.candidates[1].a1}›?</p>}
      {phase.kind === 'not_applicable' && <p>La muestra no presenta la ambigüedad esperada. No se ha creado una regla.</p>}
      {phase.kind === 'draft' && <>
        {phase.previous && <p>Cambio de columna: {phase.previous.rule.header.a1} → {phase.current.rule.header.a1}</p>}
        <div className={`grid min-w-0 gap-2 ${phase.previous ? 'sm:grid-cols-2' : ''}`}>
          {phase.previous && <DraftSummary label="Revisión anterior" draft={phase.previous} />}
          <DraftSummary label="Revisión actual" draft={phase.current} />
        </div>
      </>}
    </div>
    {canSend && <form onSubmit={submit} className="space-y-3">
      {question && <>
        <label htmlFor="draft-supplier" className="block text-sm font-medium">Comercializadora</label>
        <select id="draft-supplier" disabled={sending} className="block max-w-full rounded-md border bg-background p-2" value={supplier}
          onChange={(event) => { setSupplier(event.target.value); setError(''); }}>
          <option value="">Selecciona una comercializadora</option>
          <option value={demoSupplier}>Comercializadora Demo</option>
        </select>
        <label htmlFor="draft-answer" className="block text-sm font-medium">{prior ? 'Corrección' : 'Respuesta'}</label>
        <p id="draft-answer-hint" className="text-sm text-muted-foreground">Escribe «La columna B» o «La columna C».</p>
        <textarea id="draft-answer" rows={2} aria-describedby="draft-answer-hint" disabled={sending} className="block w-full rounded-md border bg-background p-2"
          value={answer} onChange={(event) => { setAnswer(event.target.value); setError(''); }} />
      </>}
      <label htmlFor="draft-workbook" className="block text-sm font-medium">Excel de muestra (.xlsx)</label>
      <input id="draft-workbook" ref={input} type="file" accept=".xlsx" className="block max-w-full text-sm" disabled={sending} aria-describedby="draft-hint"
        onChange={(event) => { if (!pending.current) { setFile(event.target.files?.[0]); setError(''); } }} />
      {file && <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0">Seleccionado: {file.name}</span>
        <Button type="button" variant="outline" disabled={sending} aria-label="Quitar Excel de muestra" onClick={() => { clearFile(); setError(''); }}>Quitar</Button>
      </div>}
      <Button type="submit" disabled={sending}>{prior ? 'Enviar corrección' : question ? 'Generar borrador' : 'Preguntar por la columna'}</Button>
      {sending && <p role="status">Enviando…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>}
    <Button type="button" variant="outline" onClick={() => { reset(); input.current?.focus(); }}>
      {canSend ? 'Cancelar borrador' : 'Empezar otra prueba'}
    </Button>
  </section>;
}
