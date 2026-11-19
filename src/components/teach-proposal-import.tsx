'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/firebase/client';
import { authFetch } from '@/lib/api-client';
import { importAttemptHeader, importListPage, importPath, importsPath, isTeachImportEnabled,
  readImportPage, readImportReceipt, type ImportPage, type ImportReceipt } from '@/lib/teach-proposal-import';
import { validWorkbookFilename, workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const denied = (status: number) => [401, 403, 404].includes(status);
const unconfirmed = 'No se pudo confirmar el resultado. Consulta el listado.';

export function TeachProposalImport({ list = false }: { list?: boolean }) {
  return isTeachImportEnabled() ? <AccountGate list={list} /> : null;
}

function AccountGate({ list }: { list: boolean }) {
  const [session, setSession] = useState<{ user: User | null; epoch: number }>();
  useEffect(() => onAuthStateChanged(auth, user => setSession(previous => previous?.user === user ? previous :
    { user, epoch: (previous?.epoch ?? 0) + 1 })), []);
  return session?.user && session.user === auth.currentUser ?
    <AccessGate key={`${session.epoch}:${list}`} user={session.user} list={list} /> : null;
}

function AccessGate({ user, list }: { user: User; list: boolean }) {
  const [access, setAccess] = useState<'pending' | 'granted' | 'denied' | 'error'>('pending');
  useEffect(() => {
    const request = new AbortController();
    const current = () => !request.signal.aborted && auth.currentUser === user;
    void authFetch('/api/teach-me/check-access', { cache: 'no-store', redirect: 'error', signal: request.signal }, current)
      .then(result => { if (current()) setAccess(result.status === 204 ? 'granted' : denied(result.status) ? 'denied' : 'error'); })
      .catch(() => { if (current()) setAccess('error'); });
    return () => request.abort();
  }, [user]);

  if (access !== 'granted') return list
    ? <p role="status">{access === 'pending' ? 'Comprobando acceso a Excel…' : access === 'error'
      ? 'No se pudo comprobar el acceso a Excel.' : 'Acceso a Excel no disponible.'}</p> : null;
  const revoke = () => setAccess('denied');
  return (
    <section aria-label="Excel · QA sintético" className="my-6 min-w-0 space-y-3 rounded-lg border bg-card p-4 [overflow-wrap:anywhere]">
      <h2 className="text-xl font-semibold">Excel · QA sintético</h2>
      {list ? <ImportList user={user} revoke={revoke} /> : <Upload user={user} revoke={revoke} />}
    </section>
  );
}

type Session = { user: User; revoke: () => void };

function useImportRequest(user: User) {
  const active = useRef<AbortController | null>(null);
  function cancel() { active.current?.abort(); active.current = null; }
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  function begin() {
    if (active.current || auth.currentUser !== user) return null;
    const request = new AbortController();
    active.current = request;
    const current = () => active.current === request && !request.signal.aborted && auth.currentUser === user;
    return { current, signal: request.signal, finish: () => { if (active.current === request) active.current = null; } };
  }
  return { begin, cancel };
}

function Upload({ user, revoke }: Session) {
  const { begin, cancel } = useImportRequest(user);
  const field = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ id: string; file: File } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'unknown' | 'recovering' | 'error'>('idle');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const busy = state === 'sending' || state === 'recovering';
  const unresolved = state === 'unknown' || state === 'recovering';

  function clearFile() {
    setFile(null);
    attempt.current = null;
    if (field.current) field.current.value = '';
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const recovering = state === 'unknown';
    if (busy || !file || (recovering && !attempt.current)) return;
    const flight = begin(); // synchronous: two submit events cannot send two attempts
    if (!flight) return;
    setState(recovering ? 'recovering' : 'sending');
    setReceipt(null);
    try {
      let sending = attempt.current;
      if (!sending) {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        sending = { id, file };
        attempt.current = sending;
      }
      const name = btoa(String.fromCharCode(...new TextEncoder().encode(sending.file.name)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const result = await authFetch(importPath, { method: 'POST', body: sending.file, cache: 'no-store', redirect: 'error', signal: flight.signal,
        headers: { 'Content-Type': workbookMediaType, [workbookFilenameHeader]: name, [importAttemptHeader]: sending.id } }, flight.current);
      if (!flight.current()) return;
      if (denied(result.status)) { clearFile(); revoke(); return; }
      // Rejection of a recovery request does not settle the earlier submission.
      if (!recovering && [400, 409, 413, 415, 429].includes(result.status)) {
        clearFile();
        setError(result.status === 409 ? 'No se pudo importar este Excel con la revisión activa.' :
          result.status === 429 ? 'El piloto está ocupado. Selecciona de nuevo el Excel para otro envío.' : 'El archivo Excel no es válido para este piloto.');
        setState('error');
        return;
      }
      if (!result.ok) throw new Error('Unconfirmed import');
      const stored = readImportReceipt(await result.json(), result.status);
      if (!flight.current()) return;
      if (!stored) throw new Error('Unconfirmed receipt');
      clearFile();
      setReceipt(stored);
      setState('idle');
    } catch { if (flight.current()) setState('unknown'); }
    finally { flight.finish(); }
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">Un archivo XLSX sintético. No se añade a la cola PDF.</p>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block" htmlFor="teach-proposal-workbook">Archivo Excel del piloto</label>
        <input ref={field} id="teach-proposal-workbook" className="block w-full text-sm" type="file" accept=".xlsx"
          disabled={busy || (unresolved && !!file)} onChange={event => {
            const chosen = event.currentTarget.files?.[0];
            setReceipt(null);
            attempt.current = null;
            if (chosen && (!validWorkbookFilename(chosen.name) || chosen.size < 1 || chosen.size > workbookBodyLimit)) {
              clearFile(); setError('Elige un archivo .xlsx de hasta 5 MiB.'); setState('error');
            } else { setFile(chosen ?? null); setState('idle'); }
          }} />
        <div className="flex flex-wrap gap-2">
          <Button className="h-auto min-h-10 whitespace-normal" type="submit" disabled={!file || busy}>{unresolved && file ? 'Repetir el mismo intento' : 'Importar Excel'}</Button>
          {file && <Button type="button" variant="outline" onClick={() => {
            cancel(); clearFile(); setState(busy ? 'unknown' : 'idle');
          }}>Cancelar</Button>}
        </div>
      </form>
      {state === 'sending' && <p role="status">Importando Excel…</p>}
      {state === 'recovering' && <p role="status">Comprobando el mismo intento…</p>}
      {state === 'error' && <p role="alert">{error}</p>}
      {unresolved && <p role="alert">{unconfirmed}</p>}
      {receipt && <p role="status">{receipt.kind === 'stored' ? 'Importación guardada' : 'Importación ya guardada'} #{receipt.importId} · {receipt.proposalCount} propuestas · revisión <code>{receipt.revisionId}</code> (generación {receipt.generation}).</p>}
      <Link className="inline-block underline" href={importListPage}>Consultar listado de Excel</Link>
    </>
  );
}

function ImportList({ user, revoke }: Session) {
  const { begin } = useImportRequest(user);
  const [page, setPage] = useState<ImportPage | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState(0);

  useEffect(() => {
    const flight = begin();
    if (!flight) return;
    setState('loading');
    setPage(null);
    void (async () => {
      try {
        const response = await authFetch(importsPath + (cursor ? '?cursor=' + cursor : ''),
          { signal: flight.signal, cache: 'no-store', redirect: 'error' }, flight.current);
        if (!flight.current()) return;
        if (denied(response.status)) { revoke(); return; }
        if (!response.ok) throw new Error('List unavailable');
        const parsed = readImportPage(await response.json(), cursor);
        if (!parsed) throw new Error('Invalid list page');
        if (flight.current()) { setPage(parsed); setState('ready'); }
      } catch { if (flight.current()) setState('error'); }
      finally { flight.finish(); }
    })();
  // The account/view boundary is keyed; cursor and deliberate refresh are the only dispatches within it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, load]);

  return (
    <>
      <p className="text-sm text-muted-foreground">Solo tus importaciones sintéticas. — indica un período sin precio de origen.</p>
      <Button className="h-auto min-h-10 whitespace-normal" type="button" variant="outline" disabled={state === 'loading'} onClick={() => { setCursor(null); setLoad(n => n + 1); }}>
        Consultar desde el inicio
      </Button>
      {state === 'loading' && <p role="status">Cargando importaciones de Excel…</p>}
      {state === 'error' && <p role="alert">No se pudo consultar el listado de Excel.</p>}
      {page?.batches.length === 0 && <p role="status">No hay importaciones de Excel en esta página.</p>}
      {page?.batches.map(batch => (
        <article className="space-y-2 rounded-md border p-3" key={batch.importId}>
          <h3 className="font-semibold">Importación #{batch.importId} · {batch.supplierKey}</h3>
          <p>Revisión <code>{batch.revisionId}</code> · generación {batch.generation}</p>
          <time className="text-sm" dateTime={batch.importedAt}>{batch.importedAt}</time>
          <ul className="grid gap-3 md:grid-cols-3">
            {batch.proposals.map(row => (
              <li className="min-w-0 rounded border p-2 text-sm" key={row.proposalCell.a1}>
                <h4 className="font-semibold">{row.proposal} · {row.tariff}</h4>
                <p>{row.priceType} · {row.proposalCell.sheet}!{row.proposalCell.a1} / {row.tariffCell.a1} / {row.typeCell.a1}</p>
                <ul>
                  {row.prices.map(price => <li key={price.cell.a1}>{price.term === 'energy' ? 'Energía' : 'Potencia'} {price.period}: {price.decimal} {price.unit} ({price.header.a1} → {price.cell.a1})</li>)}
                  <li>Energía P2 / P3: —</li>
                </ul>
              </li>
            ))}
          </ul>
        </article>
      ))}
      {page?.nextCursor && <Button type="button" variant="outline" onClick={() => setCursor(page.nextCursor)}>Siguiente página</Button>}
    </>
  );
}
