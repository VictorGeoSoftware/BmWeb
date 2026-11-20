import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TeachProposalImport } from '@/components/teach-proposal-import';
import { importsPath, validationPath } from '@/lib/teach-proposal-import';
import { pricePreviewFixture } from '@/lib/teach-draft-preview.testing';

type Actor = { uid: string; getIdToken: () => Promise<string> };
const session = vi.hoisted(() => ({ auth: { currentUser: null as Actor | null }, listener: null as ((user: Actor | null) => void) | null }));
vi.mock('@/lib/firebase/client', () => ({ auth: session.auth }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_auth: unknown, listener: NonNullable<typeof session.listener>) => {
  session.listener = listener; listener(session.auth.currentUser); return () => { session.listener = null; };
} }));
vi.mock('@/lib/env', () => ({ isQA: true }));

const getToken = vi.fn<() => Promise<string>>();
const requests = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const ref = '00000000-0000-4000-8000-000000000001';
const at = '2026-03-01T10:11:12.123456Z';
const revisionId = 'a'.repeat(64);
const saved = { kind: 'validated' as const, validatedAt: at };
const receipt = { ...saved, importId: '37', revisionId, generation: '1' };
const validationUrl = importsPath + '?validation=1';
const anchoredUrl = validationUrl + '&cursor=38';
const allow = () => new Response(null, { status: 204 });
const target = (validation: { kind: 'validated'; validatedAt: string } | null = null) => ({
  importId: '37', revisionId, generation: '1', supplierKey: 'gesternova', importedAt: at,
  proposals: pricePreviewFixture().rows, validationRef: ref, validation,
});
const second = { ...target(), importId: '38', revisionId: 'b'.repeat(64), generation: '2', validationRef: ref.slice(0, -1) + '2' };
const list = (...batches: ReturnType<typeof target>[]) => Response.json({ kind: 'imports', batches, nextCursor: null });
const calls = (url: string) => requests.mock.calls.filter(([path]) => url === path);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const button = (name: string) => screen.getByRole('button', { name });
const confirmButton = () => button('Confirmar que los precios guardados coinciden');

beforeEach(() => {
  requests.mockReset();
  session.auth.currentUser = { uid: 'author', getIdToken: getToken.mockReset().mockResolvedValue('fixture-token') };
  vi.stubGlobal('fetch', requests);
  vi.stubEnv('NEXT_PUBLIC_TEACH_IMPORT_PILOT', 'true');
  vi.stubEnv('NEXT_PUBLIC_TEACH_VALIDATION_PILOT', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('requires explicit keyboard confirmation of the displayed exact batch; cancel restores focus and writes nothing', async () => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(second, target()));
  const post = deferred<Response>();
  const readback = deferred<Response>();
  requests.mockReturnValueOnce(post.promise).mockReturnValueOnce(readback.promise);
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  const card = (await screen.findByRole('heading', { name: /Importación #37/ })).closest('article')!;
  const trigger = within(card).getByRole('button', { name: 'Validar resultado' });
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(new RegExp(revisionId));
  expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/generación 1/);
  expect(button('Cancelar')).toHaveFocus();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(calls(validationPath)).toHaveLength(0);
  await user.keyboard('{Enter}');
  const confirmation = confirmButton();
  act(() => { fireEvent.click(confirmation); fireEvent.click(confirmation); });
  await waitFor(() => expect(calls(validationPath)).toHaveLength(1));
  expect(JSON.parse(String(calls(validationPath)[0][1]?.body))).toEqual({ validationRef: ref, confirmExpectedPrices: true });
  await act(async () => post.resolve(Response.json(receipt, { status: 201 })));
  await waitFor(() => expect(calls(anchoredUrl)).toHaveLength(1));
  expect(screen.queryByText(/Resultado validado en QA/)).not.toBeInTheDocument();
  await act(async () => readback.resolve(list(target(saved))));
  expect(within(card).getByText(/Resultado validado en QA/)).toBeVisible();
  expect(screen.getByText('Sin validar')).toBeVisible();
  expect(within(within(card).getByText(/Resultado validado en QA/)).getByText(at, { selector: 'time[datetime]' })).toBeVisible();
});

it('does not auto retry, treats null and mismatched evidence as uncertain, and lets only the same ref be deliberately replayed', async () => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target()))
    .mockRejectedValueOnce(new TypeError('synthetic response lost')).mockResolvedValueOnce(list(target()))
    .mockResolvedValueOnce(Response.json({ ...receipt, revisionId: second.revisionId }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ ...receipt, kind: 'alreadyValidated' }))
    .mockResolvedValueOnce(list(target(saved)));
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  await user.click(confirmButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar el resultado. Vuelve a consultar esta importación');
  expect(calls(validationPath)).toHaveLength(1);
  await user.click(button('Consultar esta importación'));
  await screen.findByRole('alert');
  expect(calls(anchoredUrl)).toHaveLength(1);
  for (const n of [2, 3]) {
    await user.click(button('Volver a confirmar este resultado'));
    await user.click(confirmButton());
    await waitFor(() => expect(calls(validationPath)).toHaveLength(n));
    expect(calls(validationPath)[n - 1][1]?.body).toBe(calls(validationPath)[0][1]?.body);
    if (n === 2) await screen.findByRole('alert');
  }
  expect(await screen.findByText(/Resultado validado en QA/)).toBeVisible();
});

it('reconstructs from the enriched GET and resolves response loss by a read of the same ref only', async () => {
  const otherRef = { ...target(saved), validationRef: second.validationRef };
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target()))
    .mockResolvedValueOnce(new Response(null, { status: 408 })).mockResolvedValueOnce(list(otherRef)).mockResolvedValueOnce(list(target(saved)));
  const user = userEvent.setup();
  const view = render(<TeachProposalImport list />);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  await user.click(confirmButton());
  await screen.findByRole('alert');
  await user.click(button('Consultar esta importación'));
  await screen.findByRole('alert');
  expect(screen.queryByText(/Resultado validado en QA/)).not.toBeInTheDocument();
  await user.click(button('Consultar esta importación'));
  expect(await screen.findByText(/Resultado validado en QA/)).toBeVisible();
  expect(calls(validationPath)).toHaveLength(1);
  view.unmount();
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target(saved)));
  render(<TeachProposalImport list />);
  expect(await screen.findByText(/Resultado validado en QA/)).toBeVisible();
  expect(calls(validationPath)).toHaveLength(1);
});

it('blocks token-late submits even on a leave-and-return to the same account, and discards late replies on leaving Excel', async () => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target()));
  const user = userEvent.setup();
  const view = render(<TeachProposalImport list />);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  const token = deferred<string>();
  getToken.mockReturnValueOnce(token.promise);
  await user.click(confirmButton());
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target()));
  await act(async () => {
    const original = session.auth.currentUser;
    const replacement = { uid: 'different', getIdToken: async () => 'other-token' };
    session.auth.currentUser = replacement; session.listener?.(replacement);
    session.auth.currentUser = original; session.listener?.(original);
    token.resolve('fixture-token');
    await token.promise;
  });
  expect(calls(validationPath)).toHaveLength(0);
  const reply = deferred<Response>();
  requests.mockReturnValueOnce(reply.promise);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  await user.click(confirmButton());
  await waitFor(() => expect(calls(validationPath)).toHaveLength(1));
  requests.mockResolvedValueOnce(allow());
  view.rerender(<TeachProposalImport />);
  expect(calls(validationPath)[0][1]?.signal?.aborted).toBe(true);
  await act(async () => reply.resolve(Response.json(receipt, { status: 201 })));
  expect(calls(validationUrl)).toHaveLength(2);
  expect(calls(anchoredUrl)).toHaveLength(0);
  expect(screen.queryByText(/Resultado validado en QA/)).not.toBeInTheDocument();
});

it('recovers the exact older card after four newer imports displace it from the first page, without another POST', async () => {
  const newer = [42, 41, 40, 39].map(id => ({ ...target(), importId: String(id), validationRef: ref.slice(0, -2) + id }));
  let displaced = false;
  requests.mockImplementation(async (path) => {
    if (path === '/api/teach-me/check-access') return allow();
    if (path === validationUrl) return displaced ? list(...newer) : list(target());
    if (path === validationPath) {
      displaced = true;
      return new Response(null, { status: 408 });
    }
    if (path === anchoredUrl) return list(target(saved));
    throw new Error('Unexpected request');
  });
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  await user.click(confirmButton());
  await screen.findByRole('alert');
  await user.click(button('Consultar esta importación'));
  const card = screen.getByRole('heading', { name: /Importación #37/ }).closest('article')!;
  expect(await within(card).findByText(/Resultado validado en QA/)).toBeVisible();
  expect(calls(validationUrl)).toHaveLength(1);
  expect(calls(anchoredUrl)).toHaveLength(1);
  expect(calls(validationPath)).toHaveLength(1);
});

it.each([
  ['9223372036854775806', validationUrl + '&cursor=9223372036854775807'],
  ['9223372036854775807', validationUrl],
])('uses a bounded exact successor for import %s, or the first page for the largest ID', async (importId, recoveryUrl) => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list({ ...target(), importId }))
    .mockResolvedValueOnce(Response.json({ ...receipt, importId }, { status: 201 }))
    .mockResolvedValueOnce(list({ ...target(saved), importId }));
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  await user.click(confirmButton());
  expect(await screen.findByText(/Resultado validado en QA/)).toBeVisible();
  expect(requests.mock.calls.map(([url]) => url)).toEqual(['/api/teach-me/check-access', validationUrl, validationPath, recoveryUrl]);
});

it.each([
  ['503', () => new Response(null, { status: 503 })],
  ['malformed response', () => Response.json({ kind: 'imports', batches: [second, second], nextCursor: null })],
] as const)('labels retained data after %s, preserves exact-card uncertainty and restores ordinary actions only on a fresh page', async (_label, failure) => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(second, target()))
    .mockResolvedValueOnce(new Response(null, { status: 408 })).mockResolvedValueOnce(failure())
    .mockResolvedValueOnce(list(target())).mockResolvedValueOnce(list(second, target()));
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  const a = (await screen.findByRole('heading', { name: /Importación #37/ })).closest('article')!;
  const b = screen.getByRole('heading', { name: /Importación #38/ }).closest('article')!;
  await user.click(within(a).getByRole('button', { name: 'Validar resultado' }));
  await user.click(confirmButton());
  await within(a).findByRole('alert');
  await user.click(button('Consultar desde el inicio'));
  expect(await screen.findByText('No se pudo consultar el listado de Excel.')).toBeVisible();
  expect(screen.getByText('Se muestran datos de la consulta anterior. El listado no está actualizado.')).toBeVisible();
  expect(within(b).getByText('Estado de validación no actualizado')).toBeVisible();
  expect(within(b).queryByText('Sin validar')).not.toBeInTheDocument();
  expect(within(b).queryByRole('button', { name: 'Validar resultado' })).not.toBeInTheDocument();
  expect(within(a).getByRole('button', { name: 'Volver a confirmar este resultado' })).toBeVisible();
  await user.click(within(a).getByRole('button', { name: 'Consultar esta importación' }));
  await within(a).findByRole('alert');
  expect(calls(anchoredUrl)).toHaveLength(1);
  expect(calls(validationPath)).toHaveLength(1);
  await user.click(button('Consultar desde el inicio'));
  expect(await within(b).findByRole('button', { name: 'Validar resultado' })).toBeVisible();
  expect(within(b).getByText('Sin validar')).toBeVisible();
  expect(within(a).getByText('Validación aún no confirmada')).toBeVisible();
  expect(screen.queryByText(/datos de la consulta anterior/)).not.toBeInTheDocument();
});

it.each([401, 403, 404])('clears retained cards instead of showing stale data after a %s enriched refresh', async status => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target()))
    .mockResolvedValueOnce(new Response(null, { status }));
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  await screen.findByText('Sin validar');
  await user.click(button('Consultar desde el inicio'));
  expect(await screen.findByText('Acceso a Excel no disponible.')).toBeVisible();
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  expect(screen.queryByText(/datos de la consulta anterior/)).not.toBeInTheDocument();
  expect(calls(validationPath)).toHaveLength(0);
});

it('blocks an ordinary confirmation still waiting for its token when the displayed page becomes stale', async () => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(list(target()))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const user = userEvent.setup();
  render(<TeachProposalImport list />);
  await user.click(await screen.findByRole('button', { name: 'Validar resultado' }));
  const token = deferred<string>();
  getToken.mockReturnValueOnce(token.promise);
  await user.click(confirmButton());
  await user.click(button('Consultar desde el inicio'));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar el listado de Excel.');
  await act(async () => token.resolve('fixture-token'));
  expect(screen.getByText('Estado de validación no actualizado')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Volver a confirmar este resultado' })).not.toBeInTheDocument();
  expect(calls(validationPath)).toHaveLength(0);
});

it('does not reinterpret denied or malformed enriched reads as unvalidated; disabled mode keeps the exact normal wire', async () => {
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(Response.json({ kind: 'imports', batches: [target(), target()], nextCursor: null }));
  const view = render(<TeachProposalImport list />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar el listado de Excel');
  expect(screen.queryByText('Sin validar')).not.toBeInTheDocument();
  view.unmount();
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(new Response(null, { status: 403 }));
  const denied = render(<TeachProposalImport list />);
  expect(await screen.findByText('Acceso a Excel no disponible.')).toBeVisible();
  denied.unmount();
  vi.stubEnv('NEXT_PUBLIC_TEACH_VALIDATION_PILOT', 'false');
  const { validationRef: _, validation: __, ...plain } = target();
  requests.mockResolvedValueOnce(allow()).mockResolvedValueOnce(Response.json({ kind: 'imports', batches: [plain], nextCursor: null }));
  render(<TeachProposalImport list />);
  expect(await screen.findByText(revisionId)).toBeVisible();
  expect(calls(importsPath)).toHaveLength(1);
  expect(screen.queryByText('Sin validar')).not.toBeInTheDocument();
  expect(calls(validationPath)).toHaveLength(0);
});
