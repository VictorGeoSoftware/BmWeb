import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TeachMePage from '@/app/dashboard/teach-me/page';
import { draftPreviewMediaType, previewProfile } from '@/lib/teach-draft-preview';
import { pricePreviewFixture, previewDraftFixture } from '@/lib/teach-draft-preview.testing';
import { qaPilotPreviewMediaType } from '@/lib/teach-skill-activation';

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

const token = vi.fn<() => Promise<string>>();
const requests = vi.fn<(_path: string, _init: RequestInit) => Promise<Response>>();
const receipt = 'fixture.' + 'x'.repeat(43);
const newRevision = previewDraftFixture.draft.revisionId;
const last = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const envelope = (previous: string | null = last, expiresAt = now() + 300) => ({ kind: 'qaPilotPreview', preview: pricePreviewFixture(),
  active: { revisionId: previous, generation: previous ? '2' : '0' }, expiresAt, receipt });
const changeAccount = (user: TestUser | null) => act(() => { firebase.auth.currentUser = user; firebase.changed?.(user); });
const defer = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
};

beforeEach(() => {
  for (const flag of ['CLARIFY', 'DRAFT', 'PREVIEW']) vi.stubEnv(`NEXT_PUBLIC_TEACH_${flag}_LOCAL`, 'true');
  vi.stubEnv('NEXT_PUBLIC_TEACH_ACTIVATION_PILOT', 'true');
  token.mockReset().mockResolvedValue('fixture-token');
  firebase.auth.currentUser = { uid: 'author', getIdToken: token };
  requests.mockReset();
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => init?.method === 'POST' ? requests(path, init) : new Response(null, { status: 204 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const fileInput = () => within(screen.getByRole('region', { name: 'Previsualización de precios' })).getByLabelText(/Excel.+xlsx/);
const chooseFile = () => fireEvent.change(fileInput(), {
  target: { files: [new File(['fixture'], 'Muestra.xlsx')] },
});
const button = (name: string) => screen.getByRole('button', { name });
async function prepare() {
  render(<TeachMePage />);
  fireEvent.click(await screen.findByRole('button', { name: /Probar previsualización/ }));
  requests.mockResolvedValueOnce(Response.json(previewDraftFixture));
  fireEvent.change(screen.getByLabelText('Perfil de la muestra'), { target: { value: previewProfile } });
  chooseFile();
  fireEvent.click(button('Preparar borrador'));
  await screen.findByText('Revisión exacta:');
  expect(screen.queryByRole('button', { name: 'Activar en QA' })).not.toBeInTheDocument();
  expect(new Headers(requests.mock.calls[0][1].headers).get('Content-Type')).toBe(draftPreviewMediaType);
}
async function preview(result: unknown = envelope(), pilot = true) {
  requests.mockResolvedValueOnce(Response.json(result));
  chooseFile();
  fireEvent.click(button('Previsualizar precios'));
  await screen.findByRole('heading', { name: /Oferta sintética A/ });
  const [, init] = requests.mock.calls.at(-1)!;
  expect(new Headers(init.headers).get('Content-Type')).toBe(pilot ? qaPilotPreviewMediaType : draftPreviewMediaType);
}
async function confirm() {
  fireEvent.click(button('Activar en QA'));
  return within(await screen.findByRole('alertdialog'));
}
const confirmName = 'Confirmar revisión en QA';

it('requires a separate deliberative keyboard confirmation and echoes both exact revisions', async () => {
  const user = userEvent.setup();
  await prepare();
  await preview();
  expect(fileInput()).toHaveValue('');
  expect(screen.queryByText(receipt)).not.toBeInTheDocument();
  button('Activar en QA').focus();
  await user.keyboard('{Enter}');
  let dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText(last)).toBeVisible();
  expect(dialog.getByText(newRevision)).toBeVisible();
  expect(dialog.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(requests).toHaveBeenCalledTimes(2);
  expect(button('Activar en QA')).toHaveFocus();
  await user.keyboard('{Enter}');
  dialog = within(await screen.findByRole('alertdialog'));
  requests.mockResolvedValueOnce(Response.json({ kind: 'activated', active: { revisionId: newRevision, generation: '3' } }));
  dialog.getByRole('button', { name: confirmName }).focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Revisión activa en QA · piloto sintético.')).toBeVisible();
  expect(requests).toHaveBeenCalledTimes(3);
  const [path, init] = requests.mock.calls[2];
  expect(path).toBe('/api/teach-me/activation');
  expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
  expect(JSON.parse(String(init.body))).toEqual({ revisionId: newRevision, expectedRevisionId: last, expectedGeneration: '2', receipt });
  expect(screen.queryByRole('button', { name: 'Activar en QA' })).not.toBeInTheDocument();
});

it('preserves ordinary preview with its UI opt-in off', async () => {
  vi.stubEnv('NEXT_PUBLIC_TEACH_ACTIVATION_PILOT', undefined);
  await prepare();
  await preview(pricePreviewFixture(), false);
  expect(screen.queryByText('QA · piloto sintético')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Activar en QA' })).not.toBeInTheDocument();
});

it('never offers an already expired proof and expires a live confirmation at the deadline', async () => {
  await prepare();
  await preview(envelope(null, now()));
  expect(screen.getByText(/La prueba ha caducado/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Activar en QA' })).not.toBeInTheDocument();
  vi.useFakeTimers();
  requests.mockResolvedValueOnce(Response.json(envelope(null, now() + 1)));
  chooseFile();
  await act(async () => { fireEvent.click(button('Previsualizar precios')); });
  fireEvent.click(button('Activar en QA'));
  expect(within(screen.getByRole('alertdialog')).getByText('Ninguna')).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByText(/La prueba ha caducado/)).toBeVisible();
});

it.each([409, 502, 'disconnect', 'invalid success'] as const)('invalidates evidence on %s and never automatically retries', async (failure) => {
  await prepare();
  await preview();
  const dialog = await confirm();
  if (failure === 'disconnect') requests.mockRejectedValueOnce(new Error('closed'));
  else if (failure === 'invalid success') requests.mockResolvedValueOnce(Response.json({ kind: 'activated', active: { revisionId: last, generation: '3' } }));
  else requests.mockResolvedValueOnce(new Response(null, { status: failure }));
  fireEvent.click(dialog.getByRole('button', { name: confirmName }));
  expect(await screen.findByRole('alert')).toHaveTextContent(failure === 409
    ? 'Vuelve a previsualizar y confirma de nuevo' : 'No se pudo confirmar el resultado. Vuelve a previsualizar para comprobar la revisión activa');
  expect(screen.queryByRole('button', { name: 'Activar en QA' })).not.toBeInTheDocument();
  expect(screen.queryByText('Activa en QA:')).not.toBeInTheDocument();
  expect(requests).toHaveBeenCalledTimes(3);
  await preview(envelope(newRevision));
  expect(screen.getByText('Esta revisión ya está activa en QA.')).toBeVisible();
});

it('rechecks the identity after the token and invalidates on account change', async () => {
  await prepare();
  await preview();
  const dialog = await confirm();
  const delayedToken = defer<string>();
  token.mockReturnValueOnce(delayedToken.promise);
  fireEvent.click(dialog.getByRole('button', { name: confirmName }));
  changeAccount({ uid: 'other', getIdToken: token });
  await act(async () => { delayedToken.resolve('old-token'); });
  expect(requests).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.queryByText(last)).not.toBeInTheDocument();
});

it('does not send an activation if the evidence expires while awaiting a token', async () => {
  await prepare();
  const expiresAt = now() + 300;
  await preview(envelope(last, expiresAt));
  const dialog = await confirm();
  const delayedToken = defer<string>();
  token.mockReturnValueOnce(delayedToken.promise);
  fireEvent.click(dialog.getByRole('button', { name: confirmName }));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000);
  try { await act(async () => { delayedToken.resolve('fixture-token'); }); }
  finally { clock.mockRestore(); }
  expect(screen.getByText(/La prueba ha caducado/)).toBeVisible();
  expect(requests).toHaveBeenCalledTimes(2);
});

it.each(['committed', 'unknown'] as const)('keeps the submitted activation in view until its result is %s', async (outcome) => {
  await prepare();
  await preview();
  const input = fileInput();
  const reset = button('Preparar otra revisión');
  const toggle = screen.getByRole('button', { name: /Probar previsualización/ });
  const dialog = await confirm();
  const response = defer<Response>();
  requests.mockReturnValueOnce(response.promise);
  const changeWorkbook = () => fireEvent.change(input, { target: { files: [new File(['other fixture'], 'Otra.xlsx')] } });
  act(() => {
    fireEvent.click(dialog.getByRole('button', { name: confirmName }));
    // Same turn: handlers must respect the lock even before the disabled UI renders.
    changeWorkbook();
    fireEvent.click(reset);
    fireEvent.click(toggle);
  });
  await waitFor(() => expect(requests).toHaveBeenCalledTimes(3));
  const [path, init] = requests.mock.calls[2];
  expect(path).toBe('/api/teach-me/activation');
  expect(input).toBeDisabled();
  expect(reset).toBeDisabled();
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(button('Previsualizar precios')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Quitar Excel' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  changeWorkbook();
  fireEvent.click(reset);
  fireEvent.click(toggle);
  fireEvent.submit(input.closest('form')!);
  expect(init.signal?.aborted).toBe(false);
  expect(screen.getByText('Confirmando activación…')).toBeVisible();
  expect(screen.queryByText(/Seleccionado: Otra/)).not.toBeInTheDocument();
  expect(requests).toHaveBeenCalledTimes(3);

  await act(async () => { response.resolve(outcome === 'committed'
    ? Response.json({ kind: 'activated', active: { revisionId: newRevision, generation: '3' } })
    : new Response(null, { status: 408 })); });
  expect(input).toBeEnabled();
  expect(reset).toBeEnabled();
  expect(toggle).toBeEnabled();
  expect(screen.queryByText('Confirmando activación…')).not.toBeInTheDocument();
  if (outcome === 'committed') {
    expect(screen.getByText('Revisión activa en QA · piloto sintético.')).toBeVisible();
  } else {
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo confirmar el resultado. Vuelve a previsualizar para comprobar la revisión activa');
    expect(screen.queryByText('Activa en QA:')).not.toBeInTheDocument();
    expect(requests).toHaveBeenCalledTimes(3);
    await preview(envelope(newRevision));
    expect(screen.getByText('Esta revisión ya está activa en QA.')).toBeVisible();
    expect(requests.mock.calls.map(([url]) => url).filter((url) => url === path)).toHaveLength(1);
  }
});

it('aborts on navigation, ignores a late activation result and blocks double confirmation', async () => {
  await prepare();
  await preview();
  const dialog = await confirm();
  const response = defer<Response>();
  requests.mockReturnValueOnce(response.promise);
  const submit = dialog.getByRole('button', { name: confirmName });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(requests).toHaveBeenCalledTimes(3));
  const signal = requests.mock.calls[2][1].signal;
  act(() => { window.dispatchEvent(new Event('pagehide')); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { response.resolve(Response.json({ kind: 'activated', active: { revisionId: newRevision, generation: '3' } })); });
  expect(screen.queryByText(/Revisión activa en QA ·/)).not.toBeInTheDocument();
  expect(screen.queryByText(last)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Activar en QA' })).not.toBeInTheDocument();
});
