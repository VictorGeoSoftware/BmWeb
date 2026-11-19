'use client';

import { FormEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/api-client';
import { referenceBodyLimit, referenceFilenameHeader, referenceFormats, ReferenceKind, validReferenceFilename } from '@/lib/teach-reference';
import { readTeachReceipt, TeachAttachment, validWorkbookFilename, workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const commentsLimit = 4096;
type Kind = 'workbook' | ReferenceKind;
const displayOrder = ['workbook', 'reference_pdf', 'reference_png'] as const;
const uploadOrder = ['reference_pdf', 'reference_png', 'workbook'] as const;
const formats = { ...referenceFormats, workbook: { mediaType: workbookMediaType, extension: '.xlsx', label: 'Excel' } };
type Message = { text: string; attachments: TeachAttachment<Kind>[] };
type Selection = { file?: File; error?: string };

function select(files: FileList | null, kind: Kind): Selection {
  if (!files?.length) return {};
  if (files.length !== 1) return { error: 'Selecciona un solo archivo para este campo.' };
  return { file: files[0], error: fileError(files[0], kind) };
}

function fileError(file: File, kind: Kind) {
  const workbook = kind === 'workbook';
  const valid = workbook ? validWorkbookFilename(file.name) : validReferenceFilename(file.name, kind);
  return valid && file.size > 0 && file.size <= (workbook ? workbookBodyLimit : referenceBodyLimit) ? undefined :
    `Selecciona un archivo ${formats[kind].extension} no vacío de hasta ${workbook ? 5 : 2} MiB con un nombre válido.`;
}

function clearInputs(inputs: Partial<Record<Kind, HTMLInputElement | null>>) {
  for (const input of Object.values(inputs)) if (input) input.value = '';
}

export function TeachWorkbookComposer({ isCurrent, onDenied }: { isCurrent: () => boolean; onDenied: () => void }) {
  const [slots, setSlots] = useState<Partial<Record<Kind, Selection>>>({});
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [progress, setProgress] = useState<{ kind: Kind; filename: string }>();
  const [notice, setNotice] = useState('');
  const [commentError, setCommentError] = useState('');
  const [uploadError, setUploadError] = useState<{ kind: Kind; message: string }>();
  const inputs = useRef<Partial<Record<Kind, HTMLInputElement | null>>>({});
  const pending = useRef<AbortController | null>(null);
  const sending = progress !== undefined;
  const selectionRejected = displayOrder.some((kind) => slots[kind]?.error);
  useLayoutEffect(() => {
    const leavePage = () => {
      pending.current?.abort();
      pending.current = null;
      // A browser may restore this document from its back/forward cache.
      clearInputs(inputs.current);
      setSlots({});
      setText('');
      setMessages([]);
      setProgress(undefined);
      setNotice('');
      setCommentError('');
      setUploadError(undefined);
    };
    window.addEventListener('pagehide', leavePage);
    return () => {
      window.removeEventListener('pagehide', leavePage);
      pending.current?.abort();
    };
  }, []);

  function changeSlot(kind: Kind, selection: Selection) {
    if (pending.current) return;
    setSlots((current) => ({ ...current, [kind]: selection }));
    setUploadError((current) => current?.kind === kind ? undefined : current);
    setNotice('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!slots.workbook?.file || selectionRejected || pending.current || !isCurrent()) return;
    setNotice('');
    setUploadError(undefined);
    setCommentError('');
    if (new TextEncoder().encode(text).length > commentsLimit) {
      setCommentError('El comentario no puede superar 4 KiB en UTF-8.');
      return;
    }

    const snapshot = uploadOrder.flatMap((kind) => {
      const file = slots[kind]?.file;
      return file ? [{ kind, file }] : [];
    });
    for (const { kind, file } of snapshot) {
      const error = fileError(file, kind);
      if (error) { changeSlot(kind, { file, error }); return; }
    }
    const request = new AbortController();
    pending.current = request;
    const current = () => !request.signal.aborted && isCurrent();
    const attachments: TeachAttachment<Kind>[] = [];
    let activeKind: Kind = 'workbook';
    try {
      for (const { kind, file } of snapshot) {
        if (!current()) return;
        activeKind = kind;
        setProgress({ kind, filename: file.name });
        const workbook = kind === 'workbook';
        const wire = btoa(String.fromCharCode(...new TextEncoder().encode(file.name))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const response = await authFetch(workbook ? '/api/teach-me/messages' : '/api/teach-me/references', {
          method: 'POST', cache: 'no-store', redirect: 'error', body: file, signal: request.signal,
          headers: { 'Content-Type': formats[kind].mediaType, [workbook ? workbookFilenameHeader : referenceFilenameHeader]: wire },
        }, current);
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) { request.abort(); onDenied(); return; }
        if (response.status !== 200) {
          setUploadError({ kind, message: response.status === 415 ? 'El servidor no admite este archivo. Puedes reemplazarlo.' :
            response.status === 413 ? 'El archivo supera el límite admitido.' : 'No se pudo enviar el archivo. Puedes volver a intentarlo.' });
          return;
        }
        const attachment = readTeachReceipt(await response.json(), kind, file.name, file.size);
        if (!current()) return;
        if (!attachment) throw new Error('Invalid attachment receipt');
        attachments.push(attachment);
      }
      if (!current()) return;
      setMessages((items) => [...items, { text, attachments }]);
      setText('');
      setSlots({});
      clearInputs(inputs.current);
      setNotice(attachments.length === 1 ? 'Excel validado.' : 'Excel y referencias validados.');
    } catch {
      if (current()) setUploadError({ kind: activeKind, message: 'No se pudo confirmar el envío. Puedes volver a intentarlo.' });
    } finally {
      if (pending.current === request) pending.current = null;
      if (current()) setProgress(undefined);
    }
  }

  return (
    <div className="mt-6 min-w-0 max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">Solo ejemplos sintéticos. Los mensajes se pierden al salir o recargar.</p>
      <ol aria-label="Mensajes de enseñanza" className="space-y-2">
        {messages.map(({ text, attachments }, index) => (
          <li key={index} className="space-y-2 rounded-md border p-3 [overflow-wrap:anywhere]">
            {text && <p className="whitespace-pre-wrap">{text}</p>}
            {displayOrder.map((kind) => {
              const attachment = attachments.find((item) => item.kind === kind);
              return attachment && <p key={kind} className="text-sm font-medium">{formats[kind].label} · {attachment.filename}</p>;
            })}
          </li>
        ))}
      </ol>
      <form className="space-y-3 rounded-md border p-3" onSubmit={submit}>
        <label className="block text-sm font-medium" htmlFor="teach-comments">Comentario (opcional, solo en esta vista)</label>
        <textarea id="teach-comments" rows={3} disabled={sending} className="block w-full rounded-md border bg-background p-2" value={text}
          aria-invalid={!!commentError} aria-describedby={commentError ? 'teach-comments-error' : undefined}
          onChange={(event) => { setText(event.target.value); setCommentError(''); }} />
        {commentError && <p id="teach-comments-error" role="alert" className="text-destructive">{commentError}</p>}
        <p id="teach-reference-hint" className="text-sm text-muted-foreground">Las referencias aportan contexto y no sustituyen al Excel obligatorio.</p>
        {displayOrder.map((kind) => {
          const workbook = kind === 'workbook';
          const id = `teach-${kind}`;
          const selection = slots[kind];
          const error = selection?.error ?? (uploadError?.kind === kind ? uploadError.message : undefined);
          return <div key={kind} className="min-w-0 space-y-2">
            <label className="block text-sm font-medium" htmlFor={id}>{workbook ? 'Adjuntar Excel (.xlsx)' : `${formats[kind].label} (opcional)`}</label>
            <input ref={(element) => { inputs.current[kind] = element; }} id={id} className="block max-w-full text-sm" type="file"
              accept={formats[kind].extension} disabled={sending} aria-invalid={!!error}
              aria-describedby={([!workbook && 'teach-reference-hint', error && `${id}-error`].filter(Boolean).join(' ') || undefined)}
              onChange={(event) => changeSlot(kind, select(event.target.files, kind))} />
            {(selection?.file || selection?.error) && <div className="flex flex-wrap items-center gap-2">
              {selection.file && <span className="min-w-0 [overflow-wrap:anywhere]">Seleccionado: {selection.file.name}</span>}
              <Button type="button" variant="outline" disabled={sending} aria-label={workbook ? undefined : `Quitar ${formats[kind].label}`} onClick={() => {
                changeSlot(kind, {});
                const input = inputs.current[kind];
                if (input && !pending.current) input.value = '';
              }}>Quitar</Button>
            </div>}
            {error && <p id={`${id}-error`} role="alert" className="text-destructive">{formats[kind].label}: {error}</p>}
          </div>;
        })}
        <Button type="submit" disabled={sending || !slots.workbook?.file || selectionRejected}>Enviar</Button>
        {(progress || notice) && <p role="status" className="[overflow-wrap:anywhere]">{progress ? `Enviando… ${formats[progress.kind].label} · ${progress.filename}` : notice}</p>}
      </form>
    </div>
  );
}
