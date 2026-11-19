'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/api-client';
import { readWorkbookReceipt, validWorkbookFilename, WorkbookAttachment, workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const endpoint = '/api/teach-me/messages';
const commentsLimit = 4096;
type Message = { text: string; attachment: WorkbookAttachment };

export function TeachWorkbookComposer({ isCurrent, onDenied }: { isCurrent: () => boolean; onDenied: () => void }) {
  const [file, setFile] = useState<File>();
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);

  function removeFile() {
    setFile(undefined);
    if (input.current) input.current.value = '';
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || pending.current || !isCurrent()) return;
    setNotice('');
    setError('');
    if (!validWorkbookFilename(file.name) || !file.size || file.size > workbookBodyLimit) {
      setError('Selecciona un archivo .xlsx no vacío de hasta 5 MiB con un nombre válido.');
      return;
    }
    if (new TextEncoder().encode(text).length > commentsLimit) {
      setError('El comentario no puede superar 4 KiB en UTF-8.');
      return;
    }

    const request = new AbortController();
    pending.current = request;
    setSending(true);
    const name = file.name;
    const size = file.size;
    const wire = btoa(String.fromCharCode(...new TextEncoder().encode(name))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const current = () => !request.signal.aborted && isCurrent();
    try {
      const response = await authFetch(endpoint, {
        method: 'POST', cache: 'no-store', redirect: 'error', body: file, signal: request.signal,
        headers: { 'Content-Type': workbookMediaType, [workbookFilenameHeader]: wire },
      });
      if (!current()) return;
      if ([401, 403, 404].includes(response.status)) { onDenied(); return; }
      if (response.status !== 200) {
        setError(response.status === 415 ? 'El servidor no admite este archivo. Puedes reemplazarlo.' :
          response.status === 413 ? 'El archivo supera el límite admitido.' : 'No se pudo enviar el Excel. Puedes volver a intentarlo.');
        return;
      }
      const attachment = readWorkbookReceipt(await response.json(), name, size);
      if (!current()) return;
      if (!attachment) throw new Error('Invalid workbook receipt');
      setMessages((items) => [...items, { text, attachment }]);
      setText('');
      removeFile();
      setNotice('Excel validado.');
    } catch {
      if (current()) setError('No se pudo confirmar el envío. Puedes volver a intentarlo.');
    } finally {
      if (pending.current === request) pending.current = null;
      if (current()) setSending(false);
    }
  }

  return (
    <div className="mt-6 min-w-0 max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">Solo ejemplos sintéticos. Los mensajes se pierden al salir o recargar.</p>
      <ol aria-label="Mensajes de enseñanza" className="space-y-2">
        {messages.map(({ text, attachment }, index) => (
          <li key={index} className="space-y-2 rounded-md border p-3 [overflow-wrap:anywhere]">
            {text && <p className="whitespace-pre-wrap">{text}</p>}
            <p className="text-sm font-medium">Excel · {attachment.filename}</p>
          </li>
        ))}
      </ol>
      <form className="space-y-3 rounded-md border p-3" onSubmit={submit}>
        <label className="block text-sm font-medium" htmlFor="teach-comments">Comentario (opcional, solo en esta vista)</label>
        <textarea id="teach-comments" rows={3} disabled={sending} className="block w-full rounded-md border bg-background p-2" value={text} onChange={(event) => setText(event.target.value)} />
        <label className="block text-sm font-medium" htmlFor="teach-workbook">Adjuntar Excel (.xlsx)</label>
        <input ref={input} id="teach-workbook" className="block max-w-full text-sm" type="file" accept=".xlsx" disabled={sending}
          onChange={(event) => { setFile(event.target.files?.[0]); setError(''); setNotice(''); }} />
        {file && <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 [overflow-wrap:anywhere]">Seleccionado: {file.name}</span>
          <Button type="button" variant="outline" disabled={sending} onClick={() => { removeFile(); setError(''); }}>Quitar</Button>
        </div>}
        <Button type="submit" disabled={sending || !file}>Enviar</Button>
        {(sending || notice) && <p role="status">{sending ? 'Enviando Excel…' : notice}</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </form>
    </div>
  );
}
