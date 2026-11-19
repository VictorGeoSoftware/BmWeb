'use client';

import { FormEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/api-client';
import { clarificationFrame, clarificationMediaType, ClarificationQuestion, readClarificationResult, validClarificationAnswer } from '@/lib/teach-clarification';
import { referenceBodyLimit, validReferenceFilename } from '@/lib/teach-reference';
import { validWorkbookFilename, workbookBodyLimit } from '@/lib/teach-workbook';

const slots = [
  { kind: 'workbook', label: 'Excel', extension: '.xlsx', limit: workbookBodyLimit, valid: validWorkbookFilename },
  { kind: 'reference_pdf', label: 'Apoyo PDF', extension: '.pdf', limit: referenceBodyLimit, valid: (name: string) => validReferenceFilename(name, 'reference_pdf') },
  { kind: 'reference_png', label: 'Apoyo PNG', extension: '.png', limit: referenceBodyLimit, valid: (name: string) => validReferenceFilename(name, 'reference_png') },
] as const;
type Slot = typeof slots[number]['kind'];
type Selection = Partial<Record<Slot, { file?: File; error?: string }>>;
type Phase = { kind: 'ask' } | ClarificationQuestion | { kind: 'not_applicable' } |
  { kind: 'acknowledged'; candidates: ClarificationQuestion['candidates']; answer: string; labels: string[] };

const sendError = 'No se pudo confirmar el envío. Puedes volver a intentarlo.';
const statusErrors: Record<number, string> = {
  409: 'Vuelve a elegir el mismo Excel que originó la pregunta.',
  413: 'La solicitud supera los límites admitidos. Revisa los archivos y el texto.',
  415: 'El servidor no admite uno de los archivos. Puedes reemplazarlo.',
};

export function TeachClarificationComposer({ isCurrent, onUnavailable }: {
  isCurrent: () => boolean;
  onUnavailable: (status: 401 | 403 | 404) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });
  const [selection, setSelection] = useState<Selection>({});
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const inputs = useRef<Partial<Record<Slot, HTMLInputElement | null>>>({});
  const pending = useRef<AbortController | null>(null);
  const candidates = phase.kind === 'question' || phase.kind === 'acknowledged' ? phase.candidates : null;

  function clearFiles() {
    for (const input of Object.values(inputs.current)) if (input) input.value = '';
    setSelection({});
  }

  function reset() {
    pending.current?.abort();
    pending.current = null;
    clearFiles();
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
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !isCurrent() || (phase.kind !== 'ask' && phase.kind !== 'question')) return;
    const workbook = selection.workbook?.file;
    if (!workbook) { setError(phase.kind === 'ask' ? 'Elige un Excel para empezar.' : 'Vuelve a elegir el mismo Excel.'); return; }
    if (Object.values(selection).some((item) => item?.error)) { setError('Revisa los archivos seleccionados.'); return; }
    const reply = phase.kind === 'question';
    if (reply && !validClarificationAnswer(answer)) { setError('Escribe una respuesta no vacía, de hasta 4 KiB en UTF-8.'); return; }
    const pdf = selection.reference_pdf?.file;
    const png = selection.reference_png?.file;
    const request = new AbortController();
    pending.current = request;
    const current = () => pending.current === request && !request.signal.aborted && isCurrent();
    setError('');
    setSending(true);
    try {
      const body = clarificationFrame(workbook, reply ? { digest: phase.workbookSha256, answer, pdf, png } : undefined);
      const response = await authFetch('/api/teach-me/clarifications', {
        method: 'POST', cache: 'no-store', redirect: 'error', body, signal: request.signal,
        headers: { 'Content-Type': clarificationMediaType },
      }, current);
      if (!current()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        reset();
        onUnavailable(response.status);
        return;
      }
      if (response.status !== 200) { setError(statusErrors[response.status] ?? sendError); return; }
      const result = readClarificationResult(await response.json());
      if (!current()) return;
      if (!result || (reply !== (result.kind === 'acknowledged'))) throw new Error('Invalid clarification result');
      clearFiles();
      setAnswer('');
      if (result.kind === 'acknowledged' && reply) {
        setPhase({ kind: 'acknowledged', candidates: phase.candidates, answer,
          labels: [pdf && `Apoyo PDF · ${pdf.name}`, png && `Apoyo PNG · ${png.name}`].filter((label): label is string => !!label) });
      } else if (result.kind !== 'acknowledged') setPhase(result);
    } catch {
      if (current()) setError(sendError);
    } finally {
      if (current()) setSending(false);
      if (pending.current === request) pending.current = null;
    }
  }

  return <section aria-label="Aclaración de ejemplo" className="min-w-0 space-y-3 rounded-md border p-3 [overflow-wrap:anywhere]">
    <p className="text-sm text-muted-foreground">Usa solo ejemplos sintéticos. La conversación se pierde al salir o recargar.</p>
    {candidates && <p role="status">¿Cuál de las dos columnas de precio fijo debo usar: ‹{candidates[0].sheet} · {candidates[0].a1}› o ‹{candidates[1].sheet} · {candidates[1].a1}›?</p>}
    {phase.kind === 'not_applicable' && <p role="status">Este ejemplo no presenta la ambigüedad esperada. Puedes elegir otro Excel.</p>}
    {phase.kind === 'acknowledged' && <div className="space-y-2">
      <p className="whitespace-pre-wrap">{phase.answer}</p>
      {phase.labels.map((label) => <p key={label} className="text-sm font-medium">{label}</p>)}
      <p role="status">Respuesta recibida para esta prueba. No se ha creado ninguna regla.</p>
    </div>}
    {(phase.kind === 'ask' || phase.kind === 'question') && <form onSubmit={submit} className="space-y-3">
      {phase.kind === 'question' && <>
        <p id="clarification-reply-hint" className="text-sm text-muted-foreground">Vuelve a elegir el mismo Excel. Tu respuesta y los archivos seleccionados se enviarán al backend QA local para contestar; PDF y PNG son solo apoyo.</p>
        <label htmlFor="clarification-answer" className="block text-sm font-medium">Respuesta</label>
        <textarea id="clarification-answer" rows={3} disabled={sending} className="block w-full rounded-md border bg-background p-2" value={answer}
          onChange={(event) => { setAnswer(event.target.value); setError(''); }} />
      </>}
      {slots.slice(0, phase.kind === 'question' ? 3 : 1).map(({ kind, label, extension, limit, valid }) => {
        const id = `clarification-${kind}`;
        const item = selection[kind];
        return <div key={kind} className="min-w-0 space-y-2">
          <label htmlFor={id} className="block text-sm font-medium">{label} ({kind === 'workbook' ? extension : 'opcional'})</label>
          <input ref={(element) => { inputs.current[kind] = element; }} id={id} type="file" accept={extension}
            className="block max-w-full text-sm" disabled={sending} aria-invalid={!!item?.error}
            aria-describedby={item?.error ? `${id}-error` : phase.kind === 'question' ? 'clarification-reply-hint' : undefined}
            onChange={(event) => {
              if (pending.current) return;
              const files = event.target.files;
              const file = files?.length === 1 ? files[0] : undefined;
              const error = files?.length && (!file || !valid(file.name) || !file.size || file.size > limit)
                ? `Elige un archivo ${extension} no vacío de hasta ${limit / (1024 * 1024)} MiB con un nombre válido.` : undefined;
              setSelection((previous) => ({ ...previous, [kind]: { file, error } }));
              setError('');
            }} />
          {(item?.file || item?.error) && <div className="flex flex-wrap items-center gap-2">
            {item.file && <span className="min-w-0">Seleccionado: {item.file.name}</span>}
            <Button type="button" variant="outline" disabled={sending} aria-label={`Quitar ${label}`} onClick={() => {
              if (pending.current) return;
              const input = inputs.current[kind];
              if (input) input.value = '';
              setSelection((previous) => ({ ...previous, [kind]: undefined }));
              setError('');
            }}>Quitar</Button>
          </div>}
          {item?.error && <p id={`${id}-error`} role="alert" className="text-destructive">{item.error}</p>}
        </div>;
      })}
      <Button type="submit" disabled={sending}>{phase.kind === 'ask' ? 'Pedir aclaración' : 'Enviar respuesta'}</Button>
      {sending && <p role="status">Enviando…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>}
    <Button type="button" variant="outline" onClick={reset}>
      {phase.kind === 'acknowledged' || phase.kind === 'not_applicable' ? 'Empezar otra' : 'Cancelar aclaración'}
    </Button>
  </section>;
}
