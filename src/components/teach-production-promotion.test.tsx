import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from 'firebase/auth';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TeachProductionPromotion } from '@/components/teach-production-promotion';
import { TeachProposalValidation } from '@/components/teach-proposal-validation';
import { promotionPath, promotionRefHeader } from '@/lib/teach-production-promotion';
import type { ValidatableImportBatch } from '@/lib/teach-proposal-import';

const session = vi.hoisted(() => ({ currentUser: null as User | null }));
vi.mock('@/lib/firebase/client', () => ({ auth: session }));
vi.mock('@/lib/env', () => ({ isQA: true }));
const fetches = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const validatedAt = '2026-03-01T10:11:12Z';
const url = 'https://pr-pilot.invalid/bm-pilot/skills-fixture/pull/42';
const exact = { importId: '37', revisionId: 'a'.repeat(64), generation: '1', validatedAt };
const target: ValidatableImportBatch = { importId: exact.importId, revisionId: exact.revisionId, generation: exact.generation,
  validationRef: '00000000-0000-4000-8000-000000000001', supplierKey: 'gesternova', importedAt: validatedAt,
  validation: { kind: 'validated', validatedAt }, proposals: [] };
const posts = () => fetches.mock.calls.filter(([path, init]) => path === promotionPath && init?.method === 'POST');
const button = (name: string) => screen.getByRole('button', { name });
const trigger = 'Solicitar promoción a producción';
const revoke = vi.fn();
const view = (fresh = true, batch = target) => <TeachProductionPromotion user={session.currentUser!} canAccess={() => true}
  revoke={revoke} batch={batch} validatedAt={validatedAt} fresh={fresh} />;
const unrequested = () => Response.json({ kind: 'notRequested', ...exact });
const pending = () => Response.json({ kind: 'pending', ...exact });
const opened = (status = 200, address = url) => Response.json({ kind: 'opened', ...exact, url: address, openedAt: validatedAt }, { status });

beforeEach(() => {
  session.currentUser = { uid: 'synthetic-author', getIdToken: async () => 'fixture-token' } as User;
  vi.stubGlobal('fetch', fetches.mockReset()); revoke.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('confirms one exact simulated request via keyboard, cancellation does not write, and the URL is copyable text', async () => {
  fetches.mockResolvedValueOnce(unrequested()).mockResolvedValueOnce(opened(201));
  const user = userEvent.setup();
  render(view());
  const action = await screen.findByRole('button', { name: trigger });
  action.focus(); await user.keyboard('{Enter}');
  expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/No publica ni cambia producción/);
  expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(new RegExp(exact.revisionId));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(action).toHaveFocus());
  expect(posts()).toHaveLength(0);
  await user.keyboard('{Enter}');
  const confirm = button('Confirmar solicitud simulada');
  act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
  expect(await screen.findByText('PR simulado abierto · no publicado')).toBeVisible();
  expect(screen.getByText(url).tagName).toBe('CODE');
  expect(screen.queryByRole('link')).toBeNull();
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({ validationRef: target.validationRef, confirmPromotion: true });
});

it('does not auto-retry after loss; consults by the same reference then recovers deliberately', async () => {
  fetches.mockResolvedValueOnce(unrequested()).mockRejectedValueOnce(new Error('synthetic loss'))
    .mockResolvedValueOnce(pending()).mockResolvedValueOnce(opened());
  const user = userEvent.setup(); render(view());
  await user.click(await screen.findByRole('button', { name: trigger }));
  await user.click(button('Confirmar solicitud simulada'));
  await screen.findByText(/No se pudo confirmar la solicitud/);
  expect(posts()).toHaveLength(1);
  expect(screen.queryByRole('button', { name: trigger })).toBeNull();
  await user.click(button('Consultar promoción'));
  await screen.findByText('Solicitud pendiente de confirmación');
  expect(new Headers(fetches.mock.calls[2][1]?.headers).get(promotionRefHeader)).toBe(target.validationRef);
  await user.click(button('Recuperar esta solicitud')); await user.click(button('Confirmar recuperación'));
  await screen.findByText(url);
  expect(posts().map(call => call[1]?.body)).toEqual([posts()[0][1]?.body, posts()[0][1]?.body]);
});

it('suppresses an unrequested stale target, rejects free URLs, and revokes on denial', async () => {
  fetches.mockResolvedValueOnce(unrequested()).mockResolvedValueOnce(opened(200, 'https://pr-pilot.invalid@outside.invalid/'))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const user = userEvent.setup(); render(view(false));
  await screen.findByText('Sin solicitud observada');
  expect(screen.queryByRole('button', { name: trigger })).toBeNull();
  await user.click(button('Consultar promoción')); await screen.findByText(/No se pudo confirmar la solicitud/);
  expect(screen.queryByText(/Identificador copiable/)).toBeNull();
  await user.click(button('Consultar promoción')); await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
  expect(posts()).toHaveLength(0);
});

it('aborts on account change and rejects late observations and different targets', async () => {
  let release!: (response: Response) => void;
  fetches.mockReturnValueOnce(new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(opened());
  const mounted = render(view());
  await waitFor(() => expect(fetches).toHaveBeenCalledOnce());
  const signal = fetches.mock.calls[0][1]?.signal;
  session.currentUser = { ...session.currentUser!, uid: 'synthetic-other' };
  mounted.rerender(view(true, { ...target, importId: '38', validationRef: target.validationRef.slice(0, -1) + '2' }));
  expect(signal?.aborted).toBe(true);
  await act(async () => release(opened()));
  await screen.findByText(/No se pudo confirmar la solicitud/);
  expect(screen.queryByText(url)).toBeNull();
  expect(posts()).toHaveLength(0);
});

it('only adds promotion beside committed validation when the independent UI opt-in is also enabled', async () => {
  vi.stubEnv('NEXT_PUBLIC_TEACH_IMPORT_PILOT', 'true'); vi.stubEnv('NEXT_PUBLIC_TEACH_VALIDATION_PILOT', 'true');
  vi.stubEnv('NEXT_PUBLIC_TEACH_PROMOTION_PILOT', 'false');
  const card = (batch: ValidatableImportBatch) => <TeachProposalValidation fresh user={session.currentUser!}
    canAccess={() => true} revoke={revoke} batch={batch} />;
  const mounted = render(card(target));
  expect(screen.getByText(/Resultado validado en QA/)).toBeVisible(); expect(fetches).not.toHaveBeenCalled();
  vi.stubEnv('NEXT_PUBLIC_TEACH_PROMOTION_PILOT', 'true');
  mounted.rerender(card({ ...target, validation: null, revisionId: 'b'.repeat(64), generation: '2' }));
  expect(screen.getByText('Sin validar')).toBeVisible(); expect(fetches).not.toHaveBeenCalled();
  fetches.mockResolvedValueOnce(opened());
  mounted.rerender(card(target)); await screen.findByText(url);
  expect(posts()).toHaveLength(0);
});

it('blocks first dispatch if the evidence becomes stale while acquiring the token', async () => {
  const user = userEvent.setup(); const actor = session.currentUser!;
  fetches.mockResolvedValueOnce(unrequested());
  const mounted = render(view());
  await user.click(await screen.findByRole('button', { name: trigger }));
  let release!: (token: string) => void;
  actor.getIdToken = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  await user.click(button('Confirmar solicitud simulada'));
  await waitFor(() => expect(actor.getIdToken).toHaveBeenCalledOnce());
  mounted.rerender(view(false));
  await act(async () => release('fixture-token'));
  expect(posts()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: trigger })).toBeNull();
});
