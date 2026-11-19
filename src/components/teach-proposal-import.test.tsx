import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dashboard from '@/app/dashboard/page';
import Proposals from '@/app/dashboard/price-proposals/page';
import { TeachProposalImport } from '@/components/teach-proposal-import';
import { importAttemptHeader, importListPage, importPath, importsPath } from '@/lib/teach-proposal-import';
import { workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';
import { pricePreviewFixture } from '@/lib/teach-draft-preview.testing';

type Actor = { uid: string; getIdToken: () => Promise<string> };
const state = vi.hoisted(() => ({ auth: { currentUser: null as Actor | null }, subscribed: undefined as ((user: Actor | null) => void) | undefined,
  qa: true, query: '', toast: vi.fn() }));
vi.mock('@/lib/firebase/client', () => ({ auth: state.auth }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_auth: unknown, handler: typeof state.subscribed) => {
  state.subscribed = handler; handler?.(state.auth.currentUser);
  return () => { state.subscribed = undefined; };
} }));
vi.mock('@/lib/env', () => ({ get isQA() { return state.qa; } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));

const requests = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const token = vi.fn<() => Promise<string>>();
const receipt = { kind: 'stored', importId: '37', revisionId: 'a'.repeat(64), generation: '1', proposalCount: 3 };
const stored = () => Response.json(receipt, { status: 201 });
const empty = () => Response.json({ kind: 'imports', batches: [], nextCursor: null });
const proposal = () => {
  const rows = pricePreviewFixture().rows;
  rows[0].prices[0].decimal = '0.151234567891';
  return { importId: receipt.importId, supplierKey: 'gesternova', revisionId: receipt.revisionId, generation: '1',
    importedAt: '2026-03-01T10:11:12.123456Z', proposals: rows };
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
};
const changeActor = (user: Actor | null) => act(() => { state.auth.currentUser = user; state.subscribed?.(user); });
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  state.qa = true; state.query = '';
  token.mockReset().mockResolvedValue('fixture-token');
  state.auth.currentUser = { uid: 'author', getIdToken: token };
  requests.mockReset();
  vi.stubGlobal('fetch', requests);
  vi.stubEnv('NEXT_PUBLIC_TEACH_IMPORT_PILOT', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const access = () => new Response(null, { status: 204 });
const input = () => screen.getByLabelText('Archivo Excel del piloto') as HTMLInputElement;
const choose = (file = new File(['some synthetic XLSX'], 'bm-pilot-gesternova.xlsx')) => {
  fireEvent.change(input(), { target: { files: [file] } }); return file;
};
const calls = (path: string) => requests.mock.calls.filter(([url]) => url === path);
const envelope = (batches: unknown[], nextCursor: string | null = null) => Response.json({ kind: 'imports', batches, nextCursor });

it('keeps the normal PDF dashboard and submits a separate singleton raw XLSX synchronously', async () => {
  requests.mockResolvedValueOnce(access());
  const wait = deferred<Response>();
  requests.mockReturnValueOnce(wait.promise);
  const { container } = render(<Dashboard />);
  expect(screen.getByText('Upload one or more PDF documents with the latest electricity prices.')).toBeVisible();
  const pdfControl = container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  expect(pdfControl).not.toBeNull();
  await screen.findByLabelText('Archivo Excel del piloto');
  const file = choose();
  const form = input().closest('form')!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  await waitFor(() => expect(calls(importPath)).toHaveLength(1));
  expect(screen.getByText('Importando Excel…')).toBeVisible();
  const init = calls(importPath)[0][1]!;
  expect(init).toMatchObject({ method: 'POST', body: file, redirect: 'error', cache: 'no-store' });
  const headers = new Headers(init.headers);
  expect(headers.get('content-type')).toBe(workbookMediaType);
  expect(headers.get(importAttemptHeader)).toMatch(/^[a-f0-9]{32}$/);
  expect(atob(headers.get(workbookFilenameHeader)!)).toBe(file.name);
  expect(calls('/api/price-proposal/upload')).toHaveLength(0);
  await act(async () => wait.resolve(stored()));
  expect(screen.getByText(receipt.revisionId)).toBeVisible();
  expect(input()).toHaveValue('');
  expect(button('Importar Excel')).toBeDisabled();
  expect(screen.getByRole('link', { name: 'Consultar listado de Excel' })).toHaveAttribute('href', importListPage);
  requests.mockResolvedValueOnce(Response.json({ success: true }));
  const pdf = new File(['%PDF synthetic'], 'inert.pdf', { type: 'application/pdf' });
  fireEvent.change(pdfControl!, { target: { files: [pdf] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload price proposals' }));
  await waitFor(() => expect(calls('/api/price-proposal/upload')).toHaveLength(1));
  expect((calls('/api/price-proposal/upload')[0][1]?.body as FormData).get('file')).toEqual(pdf);
  expect(calls(importPath)).toHaveLength(1);
});

it('retries only explicitly with the identical File and attempt; a new deliberate import gets a fresh ID', async () => {
  requests.mockResolvedValueOnce(access()).mockRejectedValueOnce(new TypeError('private network error'))
    .mockResolvedValueOnce(Response.json({ ...receipt, kind: 'alreadyStored' }));
  const user = userEvent.setup();
  render(<TeachProposalImport />);
  await screen.findByLabelText('Archivo Excel del piloto');
  const file = choose();
  button('Importar Excel').focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar el resultado. Consulta el listado');
  expect(calls(importPath)).toHaveLength(1);
  expect(input()).toBeDisabled();
  button('Repetir el mismo intento').focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText(receipt.revisionId)).toBeVisible();
  const [first, second] = calls(importPath).map(([, init]) => init!);
  expect(first.body).toBe(file); expect(second.body).toBe(file);
  const key = (req: RequestInit) => new Headers(req.headers).get(importAttemptHeader);
  expect(key(second)).toBe(key(first));
  requests.mockResolvedValueOnce(Response.json({ kind: 'stored', importId: '38', revisionId: receipt.revisionId, generation: '1', proposalCount: 9 }, { status: 201 }));
  choose(file);
  await user.click(button('Importar Excel'));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar el resultado');
  expect(key(calls(importPath)[2][1]!)).not.toBe(key(first));
  await user.click(button('Cancelar'));
  expect(screen.queryByRole('button', { name: 'Repetir el mismo intento' })).not.toBeInTheDocument();
  expect(input()).toHaveValue('');
});

it('keeps an unknown attempt after rejected or invalid recovery responses and settles only on a valid receipt', async () => {
  const saturated = deferred<Response>();
  requests.mockResolvedValueOnce(access())
    .mockRejectedValueOnce(new TypeError('synthetic response lost'))
    .mockReturnValueOnce(saturated.promise)
    .mockResolvedValueOnce(Response.json({ error: 'incompatible_workbook' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ...receipt, kind: 'alreadyStored', proposalCount: 2 }))
    .mockResolvedValueOnce(Response.json({ ...receipt, kind: 'alreadyStored' }));
  const user = userEvent.setup();
  render(<TeachProposalImport />);
  await screen.findByLabelText('Archivo Excel del piloto');
  const file = choose();
  await user.click(button('Importar Excel'));
  const notice = 'No se pudo confirmar el resultado. Consulta el listado.';
  const expectPending = (callsExpected: number) => {
    expect(screen.getByRole('alert')).toHaveTextContent(notice);
    expect(screen.queryByText(receipt.revisionId)).not.toBeInTheDocument();
    expect(input()).toBeDisabled();
    const sent = calls(importPath);
    expect(sent).toHaveLength(callsExpected);
    const key = new Headers(sent[0][1]?.headers).get(importAttemptHeader);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    for (const [, init] of sent) {
      expect(init?.body).toBe(file);
      expect(new Headers(init?.headers).get(importAttemptHeader)).toBe(key);
    }
  };
  await screen.findByRole('alert');
  expectPending(1);
  await user.click(button('Repetir el mismo intento'));
  expect(screen.getByText('Comprobando el mismo intento…')).toBeVisible();
  expectPending(2);
  await act(async () => saturated.resolve(new Response(null, { status: 429 })));
  expect(button('Repetir el mismo intento')).toBeEnabled();
  expectPending(2);
  for (const count of [3, 4]) {
    await user.click(button('Repetir el mismo intento'));
    expect(button('Repetir el mismo intento')).toBeEnabled();
    expectPending(count);
  }
  await user.click(button('Repetir el mismo intento'));
  expect(await screen.findByText(receipt.revisionId)).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(input()).toHaveValue('');
  expect(button('Importar Excel')).toBeDisabled();
  const sent = calls(importPath);
  expect(sent).toHaveLength(5);
  expect(sent[4][1]?.body).toBe(file);
  expect(new Headers(sent[4][1]?.headers).get(importAttemptHeader)).toBe(new Headers(sent[0][1]?.headers).get(importAttemptHeader));
});

it('denies access before any panel, drops files on denial and prevents dispatch with stale auth tokens', async () => {
  requests.mockResolvedValueOnce(access());
  render(<TeachProposalImport />);
  await screen.findByLabelText('Archivo Excel del piloto');
  choose();
  const oldToken = deferred<string>();
  token.mockReturnValueOnce(oldToken.promise);
  fireEvent.click(button('Importar Excel'));
  requests.mockResolvedValueOnce(new Response(null, { status: 403 }));
  changeActor({ uid: 'another', getIdToken: async () => 'another-token' });
  await act(async () => oldToken.resolve('old-token'));
  expect(calls(importPath)).toHaveLength(0);
  expect(screen.queryByLabelText('Archivo Excel del piloto')).not.toBeInTheDocument();
  const response = deferred<Response>();
  requests.mockResolvedValueOnce(access()).mockReturnValueOnce(response.promise);
  changeActor({ uid: 'third', getIdToken: async () => 'third-token' });
  await screen.findByLabelText('Archivo Excel del piloto');
  choose(); fireEvent.click(button('Importar Excel'));
  await waitFor(() => expect(calls(importPath)).toHaveLength(1));
  changeActor(null);
  expect(calls(importPath)[0][1]?.signal?.aborted).toBe(true);
  await act(async () => response.resolve(stored()));
  expect(screen.queryByText(receipt.revisionId)).not.toBeInTheDocument();
  requests.mockResolvedValueOnce(access()).mockResolvedValueOnce(new Response(null, { status: 403 }));
  changeActor({ uid: 'fourth', getIdToken: async () => 'fourth-token' });
  await screen.findByLabelText('Archivo Excel del piloto');
  choose(); fireEvent.click(button('Importar Excel'));
  await waitFor(() => expect(screen.queryByLabelText('Archivo Excel del piloto')).not.toBeInTheDocument());
});

it('lists independently in isolated mode, shows exact citations and handles paging, absence and reconciliation', async () => {
  state.query = 'view=excel';
  const groups = Array.from({ length: 4 }, (_, i) => ({ ...proposal(), importId: String(37 - i) }));
  requests.mockResolvedValueOnce(access()).mockResolvedValueOnce(envelope(groups, '34')).mockResolvedValueOnce(empty())
    .mockResolvedValueOnce(envelope([proposal()]));
  render(<Proposals />);
  const section = within(await screen.findByRole('region', { name: 'Excel · QA sintético' }));
  const card = within((await section.findAllByRole('article'))[0]);
  expect(card.getByText(receipt.revisionId)).toBeVisible();
  expect(card.getByText(/0\.151234567891 €\/kWh \(K14 → K16\)/)).toBeVisible();
  expect(card.getByText(/Potencia P1: 0\.07123 €\/kWdia/)).toBeVisible();
  expect(card.getByText(/Energía P1: 0 €\/kWh/)).toBeVisible();
  expect(card.getAllByText('Energía P2 / P3: —')).toHaveLength(3);
  expect(section.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByText('IVA:')).not.toBeInTheDocument();
  fireEvent.click(button('Siguiente página'));
  expect(await screen.findByText('No hay importaciones de Excel en esta página.')).toBeVisible();
  expect(calls(importsPath + '?cursor=34')).toHaveLength(1);
  fireEvent.click(button('Consultar desde el inicio'));
  expect(await screen.findByRole('heading', { name: /Importación #37/ })).toBeVisible();
  expect(calls('/api/price-proposals')).toHaveLength(0);
});

it('uses the PDF list unchanged with the pilot off or alongside Excel; rejects invalid list payloads', async () => {
  vi.stubEnv('NEXT_PUBLIC_TEACH_IMPORT_PILOT', 'false');
  const pdf = { success: true, results: [], iva: 21, impuestoElectrico: 5 };
  requests.mockResolvedValueOnce(Response.json(pdf));
  const first = render(<Proposals />);
  expect(await screen.findByText('No price proposals stored yet. Upload a PDF to get started.')).toBeVisible();
  expect(calls(importsPath)).toHaveLength(0);
  first.unmount();
  vi.stubEnv('NEXT_PUBLIC_TEACH_IMPORT_PILOT', 'true');
  requests.mockImplementation(async (path) => path === '/api/price-proposals' ? Response.json(pdf) :
    path === '/api/teach-me/check-access' ? access() : envelope([{ ...proposal(), digest: 'private' }]));
  render(<Proposals />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar el listado de Excel.');
  expect(screen.getByText('No price proposals stored yet. Upload a PDF to get started.')).toBeVisible();
  expect(screen.queryByText(receipt.revisionId)).not.toBeInTheDocument();
  expect(calls('/api/price-proposals')).toHaveLength(2);
});
