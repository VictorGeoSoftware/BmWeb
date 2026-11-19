import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import TeachMePage from '@/app/dashboard/teach-me/page';
import { authFetch } from '@/lib/api-client';
import { workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';

const firebase = vi.hoisted(() => ({
  auth: { currentUser: null as { uid: string } | null },
  changed: undefined as ((user: { uid: string } | null) => void) | undefined,
}));
vi.mock('@/lib/firebase/client', () => ({ auth: firebase.auth }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_auth: unknown, cb: typeof firebase.changed) => {
  firebase.changed = cb;
  return () => { firebase.changed = undefined; };
} }));
vi.mock('@/lib/api-client', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/env', () => ({ isQA: true }));

const fetchAuth = vi.mocked(authFetch);
const fixture = new File(['ordinary synthetic fixture'], 'Ejemplo español.xlsx');
const selector = () => screen.getByLabelText('Adjuntar Excel (.xlsx)');
const comment = () => screen.getByLabelText(/Comentario/);
const send = () => screen.getByRole('button', { name: 'Enviar' });
const receipt = (size = fixture.size) => Response.json({ attachment: { kind: 'workbook', filename: fixture.name, sizeBytes: size } });
const entries = () => screen.queryAllByRole('listitem');
function attach(text = '') {
  fireEvent.change(selector(), { target: { files: [fixture] } });
  fireEvent.change(comment(), { target: { value: text } });
}
function swapUser(user: { uid: string } | null) {
  act(() => { firebase.auth.currentUser = user; firebase.changed?.(user); });
}

beforeEach(() => {
  firebase.auth.currentUser = { uid: 'synthetic-a' };
  fetchAuth.mockReset();
  fetchAuth.mockImplementation(async (path) => path.endsWith('check-access') ? new Response(null, { status: 204 }) : receipt());
});

it('allows removal, sends only the raw File and shows separate local text only after valid confirmation', async () => {
  let finish: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  fetchAuth.mockImplementation(async (path) => path.endsWith('check-access') ? new Response(null, { status: 204 }) : pending);
  const view = render(<TeachMePage />);
  await screen.findByLabelText('Adjuntar Excel (.xlsx)');
  const localOnly = 'Comentario sintético distintivo fuera del transporte';
  attach(localOnly);
  expect(screen.getByText(`Seleccionado: ${fixture.name}`)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Quitar' }));
  expect(send()).toBeDisabled();
  expect(comment()).toHaveValue(localOnly);
  attach(localOnly);
  fireEvent.click(send());
  fireEvent.click(send());
  expect(entries()).toHaveLength(0);
  expect(screen.getByRole('status')).toHaveTextContent('Enviando Excel');
  const requests = fetchAuth.mock.calls.filter(([path]) => path.endsWith('/messages'));
  expect(requests).toHaveLength(1);
  const [path, init] = requests[0];
  expect(path).toBe('/api/teach-me/messages');
  expect(init?.headers).toEqual({ 'Content-Type': workbookMediaType,
    [workbookFilenameHeader]: Buffer.from(fixture.name).toString('base64url') });
  expect(init?.body).toBe(fixture);
  expect(JSON.stringify([path, init?.headers])).not.toContain(localOnly);
  await act(async () => { finish(receipt()); });
  expect(entries()).toHaveLength(1);
  expect(screen.getByText(localOnly)).toBeVisible();
  expect(screen.getByText(`Excel · ${fixture.name}`)).toBeVisible();
  expect(comment()).toHaveValue('');
  expect(send()).toBeDisabled();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  view.unmount();
  render(<TeachMePage />);
  await screen.findByLabelText('Adjuntar Excel (.xlsx)');
  expect(entries()).toHaveLength(0);
});

it('bounds UTF-8 comments and preserves the exact draft through invalid and rejected receipts for manual retry', async () => {
  const post = vi.fn().mockResolvedValueOnce(receipt(fixture.size + 1)).mockResolvedValueOnce(new Response(null, { status: 415 }))
    .mockResolvedValueOnce(receipt());
  fetchAuth.mockImplementation(async (path) => path.endsWith('check-access') ? new Response(null, { status: 204 }) : post());
  render(<TeachMePage />);
  await screen.findByLabelText('Adjuntar Excel (.xlsx)');
  const exact = 'é'.repeat(2048);
  attach(exact + 'a');
  fireEvent.click(send());
  expect(screen.getByRole('alert')).toHaveTextContent('4 KiB');
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(comment(), { target: { value: exact } });
  fireEvent.click(send());
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar');
  expect(comment()).toHaveValue(exact);
  expect(entries()).toHaveLength(0);
  fireEvent.click(send());
  expect(await screen.findByRole('alert')).toHaveTextContent('El servidor no admite');
  expect(entries()).toHaveLength(0);
  fireEvent.click(send());
  expect(await screen.findByText(`Excel · ${fixture.name}`)).toBeVisible();
  expect(post).toHaveBeenCalledTimes(3);
});

it('clears local entries and draft after known denial of a subsequent send', async () => {
  const post = vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(new Response(null, { status: 403 }));
  fetchAuth.mockImplementation(async (path) => path.endsWith('check-access') ? new Response(null, { status: 204 }) : post());
  render(<TeachMePage />);
  await screen.findByLabelText('Adjuntar Excel (.xlsx)');
  attach();
  fireEvent.click(send());
  expect(await screen.findByRole('listitem')).toHaveTextContent(`Excel · ${fixture.name}`);
  attach('discarded draft');
  fireEvent.click(send());
  expect(await screen.findByText(/no está disponible/)).toBeVisible();
  expect(screen.queryByLabelText(/Comentario/)).not.toBeInTheDocument();
  expect(entries()).toHaveLength(0);
});

it('aborts on account change and ignores a late successful receipt even if the request ignores abort', async () => {
  let finish: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  fetchAuth.mockImplementation(async (path) => path.endsWith('check-access') ? new Response(null, { status: 204 }) : pending);
  render(<TeachMePage />);
  await screen.findByLabelText('Adjuntar Excel (.xlsx)');
  attach('first session only');
  fireEvent.click(send());
  const [, init] = fetchAuth.mock.calls.find(([path]) => path.endsWith('/messages'))!;
  swapUser({ uid: 'synthetic-b' });
  await waitFor(() => expect(init?.signal?.aborted).toBe(true));
  await act(async () => { finish(receipt()); });
  expect(await screen.findByLabelText(/Comentario/)).toHaveValue('');
  expect(entries()).toHaveLength(0);
  expect(fetchAuth.mock.calls.filter(([path]) => path.endsWith('check-access'))).toHaveLength(2);
});
