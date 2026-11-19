import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TeachMePage from '@/app/dashboard/teach-me/page';
import { draftPreviewMediaType, previewProfile } from '@/lib/teach-draft-preview';
import { pricePreviewFixture, previewDraftFixture } from '@/lib/teach-draft-preview.testing';

type TestUser = { uid: string; getIdToken: () => Promise<string> };
const firebase = vi.hoisted(() => ({
  auth: { currentUser: null as TestUser | null },
  changed: undefined as ((user: TestUser | null) => void) | undefined,
}));
vi.mock('@/lib/firebase/client', () => ({ auth: firebase.auth }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_auth: unknown, fn: typeof firebase.changed) => {
  firebase.changed = fn;
  return () => { firebase.changed = undefined; };
} }));
vi.mock('@/lib/env', () => ({ isQA: true }));

const pending = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
};
const post = vi.fn<(init: RequestInit) => Promise<Response>>();
const token = vi.fn<() => Promise<string>>();
const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x29);
const workbook = () => new File([bytes], 'Muestra.xlsx');
const toggleName = /Probar previsualización/;
const panelName = 'Previsualización de precios';
const changeAccount = (user: TestUser | null) => act(() => { firebase.auth.currentUser = user; firebase.changed?.(user); });

beforeEach(() => {
  for (const flag of ['CLARIFY', 'DRAFT', 'PREVIEW']) vi.stubEnv(`NEXT_PUBLIC_TEACH_${flag}_LOCAL`, 'true');
  token.mockReset().mockResolvedValue('fixture-token');
  firebase.auth.currentUser = { uid: 'author', getIdToken: token };
  post.mockReset();
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(null, { status: 204 });
    expect(path).toBe('/api/teach-me/clarifications');
    return post(init);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function open() {
  fireEvent.click(await screen.findByRole('button', { name: toggleName }));
  return within(screen.getByRole('region', { name: panelName }));
}
type Panel = Awaited<ReturnType<typeof open>>;
const profile = (panel: Panel) => panel.getByLabelText('Perfil de la muestra');
const chooseProfile = (panel: Panel) => fireEvent.change(profile(panel), { target: { value: previewProfile } });
const file = (panel: Panel) => panel.getByLabelText(/Excel.+xlsx/) as HTMLInputElement;
const chooseFile = (panel: Panel, selected = workbook()) => fireEvent.change(file(panel), { target: { files: [selected] } });
const click = (panel: Panel, name: string) => fireEvent.click(panel.getByRole('button', { name }));

async function prepare(panel: Panel) {
  post.mockResolvedValueOnce(Response.json(previewDraftFixture));
  chooseProfile(panel);
  chooseFile(panel);
  click(panel, 'Preparar borrador');
  expect(await panel.findByText('Borrador sin activar')).toBeVisible();
}

async function unpack(init: RequestInit) {
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
  expect(Object.fromEntries(new Headers(init.headers))).toEqual({ authorization: 'Bearer fixture-token', 'content-type': draftPreviewMediaType });
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(init.body as Blob);
  });
  const length = new DataView(buffer).getUint32(0);
  return { tuple: JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))), bytes: [...new Uint8Array(buffer, 4 + length)] };
}

it.each(['CLARIFY', 'DRAFT', 'PREVIEW'])('does not expose the preview without its %s opt-in', async (flag) => {
  vi.stubEnv(`NEXT_PUBLIC_TEACH_${flag}_LOCAL`, undefined);
  render(<TeachMePage />);
  expect(await screen.findByRole('heading', { name: 'Enséñame' })).toBeVisible();
  expect(screen.queryByRole('button', { name: toggleName })).not.toBeInTheDocument();
});

it('explicitly prepares, releases each file, reselects the same bytes and displays the actual revision and source values', async () => {
  render(<TeachMePage />);
  const panel = await open();
  click(panel, 'Preparar borrador');
  expect(panel.getByRole('alert')).toHaveFocus();
  expect(post).not.toHaveBeenCalled();
  await prepare(panel);
  expect(panel.getByText('Borrador sin activar').closest('[tabindex]')).toHaveFocus();
  expect(file(panel)).toHaveValue('');
  expect(panel.queryByText(/Seleccionado:/)).not.toBeInTheDocument();
  expect(await unpack(post.mock.calls[0][0])).toEqual({ tuple: [1, 'prepare', bytes.length, previewProfile], bytes: [...bytes] });
  click(panel, 'Previsualizar precios');
  expect(post).toHaveBeenCalledTimes(1);
  expect(panel.getByRole('alert')).toHaveTextContent('Elige el Excel sintético original');
  const next = pending<Response>();
  post.mockReturnValueOnce(next.promise);
  chooseFile(panel);
  click(panel, 'Previsualizar precios');
  click(panel, 'Previsualizar precios');
  expect(panel.getByRole('status')).toHaveTextContent('Previsualizando…');
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  const { draft } = previewDraftFixture;
  expect(await unpack(post.mock.calls[1][0])).toEqual({ tuple: [1, 'preview', bytes.length, previewProfile,
    draft.supplierKey, draft.workbookSha256, draft.revisionId], bytes: [...bytes] });
  next.resolve(Response.json(pricePreviewFixture()));
  expect(await panel.findByText('0 €/kWh')).toBeVisible();
  expect(panel.getByText('0.02456 €/kWdia')).toBeVisible();
  expect(panel.getByText('Tarifas!K17')).toBeVisible();
  expect(panel.getAllByText('Tarifas!K14')).toHaveLength(3);
  expect(panel.getByText('Tarifas!I16')).toBeVisible();
  expect(panel.getByText('Tarifas!F16')).toBeVisible();
  expect(panel.getByText(draft.revisionId)).toBeVisible();
  expect(panel.queryByText(/Energía P2:/)).not.toBeInTheDocument();
  expect(file(panel)).toHaveValue('');
  expect(panel.getByText('Borrador sin activar').closest('[tabindex]')).toHaveFocus();
  chooseFile(panel);
  expect(panel.queryByText('0 €/kWh')).not.toBeInTheDocument();
});

it('rejects mismatched operation, revision and conflict without keeping a stale result and allows explicit retry', async () => {
  render(<TeachMePage />);
  const panel = await open();
  await prepare(panel);
  chooseFile(panel);
  for (const response of [Response.json(previewDraftFixture), Response.json({ ...pricePreviewFixture(), revisionId: '0'.repeat(64) }),
    new Response(null, { status: 409 })]) {
    post.mockResolvedValueOnce(response);
    click(panel, 'Previsualizar precios');
    expect(await panel.findByRole('alert')).toHaveFocus();
    expect(panel.queryByText('0 €/kWh')).not.toBeInTheDocument();
  }
  post.mockResolvedValueOnce(Response.json(pricePreviewFixture()));
  click(panel, 'Previsualizar precios');
  expect(await panel.findByText('0 €/kWh')).toBeVisible();
  click(panel, 'Preparar otra revisión');
  expect(panel.queryByText('Borrador sin activar')).not.toBeInTheDocument();
  expect(profile(panel)).toHaveValue('');
});

it.each(['replacement', 'close', 'pagehide', 'account', 'logout'] as const)('abandons dispatch while obtaining a token on %s', async (reason) => {
  render(<TeachMePage />);
  const panel = await open();
  chooseProfile(panel);
  chooseFile(panel);
  const waiting = pending<string>();
  token.mockReturnValueOnce(waiting.promise);
  click(panel, 'Preparar borrador');
  expect(panel.getByRole('status')).toHaveTextContent('Preparando…');
  if (reason === 'replacement') chooseFile(panel, new File([bytes], 'Otra.xlsx'));
  if (reason === 'close') fireEvent.click(screen.getByRole('button', { name: toggleName }));
  if (reason === 'pagehide') fireEvent(window, new Event('pagehide'));
  if (reason === 'account' || reason === 'logout') changeAccount(reason === 'account' ? { uid: 'new', getIdToken: token } : null);
  await act(async () => { waiting.resolve('fixture-token'); await waiting.promise; });
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByText('Borrador sin activar')).not.toBeInTheDocument();
  if (reason === 'pagehide') expect(profile(panel)).toHaveValue('');
});

it('ignores a late upload response after revision reset and clears current view on revocation', async () => {
  render(<TeachMePage />);
  const panel = await open();
  await prepare(panel);
  const waiting = pending<Response>();
  post.mockReturnValueOnce(waiting.promise);
  chooseFile(panel);
  click(panel, 'Previsualizar precios');
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  click(panel, 'Preparar otra revisión');
  expect(post.mock.calls[1][0].signal?.aborted).toBe(true);
  await act(async () => { waiting.resolve(Response.json(pricePreviewFixture())); await waiting.promise; });
  expect(panel.queryByText('0 €/kWh')).not.toBeInTheDocument();
  await prepare(panel);
  chooseFile(panel);
  post.mockResolvedValueOnce(new Response(null, { status: 403 }));
  click(panel, 'Previsualizar precios');
  expect(await screen.findByText(/no está disponible para tu cuenta/)).toBeVisible();
  expect(screen.queryByText('Borrador sin activar')).not.toBeInTheDocument();
});

it('drops a successful preview on pagehide, close and a clean mount', async () => {
  const view = render(<TeachMePage />);
  const panel = await open();
  await prepare(panel);
  chooseFile(panel);
  post.mockResolvedValueOnce(Response.json(pricePreviewFixture()));
  click(panel, 'Previsualizar precios');
  expect(await panel.findByText('0 €/kWh')).toBeVisible();
  fireEvent(window, new Event('pagehide'));
  expect(panel.queryByText('0 €/kWh')).not.toBeInTheDocument();
  expect(profile(panel)).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: toggleName }));
  expect(screen.queryByRole('region', { name: panelName })).not.toBeInTheDocument();
  view.unmount();
  render(<TeachMePage />);
  const reopened = await open();
  expect(profile(reopened)).toHaveValue('');
  expect(reopened.queryByText('Borrador sin activar')).not.toBeInTheDocument();
});
