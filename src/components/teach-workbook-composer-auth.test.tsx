import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TeachMePage from '@/app/dashboard/teach-me/page';

type TestUser = { uid: string; getIdToken: () => Promise<string> };
const firebase = vi.hoisted(() => ({
  auth: { currentUser: null as TestUser | null },
  changed: undefined as ((user: TestUser | null) => void) | undefined,
}));
vi.mock('@/lib/firebase/client', () => ({ auth: firebase.auth }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: (_auth: unknown, cb: typeof firebase.changed) => {
  firebase.changed = cb;
  return () => { firebase.changed = undefined; };
} }));
vi.mock('@/lib/env', () => ({ isQA: true }));

afterEach(() => vi.unstubAllGlobals());

it.each(['account change', 'view unmount', 'none'] as const)(
  'uses real authFetch with a deferred upload token and %s', async (change) => {
    let finish!: (value: string) => void;
    const token = new Promise<string>((resolve) => { finish = resolve; });
    const getIdToken = vi.fn().mockResolvedValue('synthetic-token').mockImplementationOnce(async () => 'synthetic-access-token')
      .mockImplementationOnce(() => token);
    firebase.auth.currentUser = { uid: 'synthetic-a', getIdToken };
    const pdf = new File(['ordinary synthetic reference'], 'Apoyo.pdf');
    const workbook = new File(['ordinary synthetic workbook'], 'Ejemplo.xlsx');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Response(null, { status: 204 });
      const file = init.body === pdf ? pdf : workbook;
      return Response.json({ attachment: { kind: file === pdf ? 'reference_pdf' : 'workbook', filename: file.name, sizeBytes: file.size } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const uploads = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    const view = render(<TeachMePage />);
    fireEvent.change(await screen.findByLabelText('Adjuntar Excel (.xlsx)'), { target: { files: [workbook] } });
    fireEvent.change(screen.getByLabelText('Referencia PDF (opcional)'), { target: { files: [pdf] } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(getIdToken).toHaveBeenCalledTimes(2);
    expect(uploads()).toHaveLength(0);

    // Let the token settle before Firebase notifies React, so unmount/abort cannot mask the identity race.
    if (change === 'account change') {
      firebase.auth.currentUser = { uid: 'synthetic-b', getIdToken: async () => 'other-synthetic-token' };
    } else if (change === 'view unmount') {
      view.unmount();
    }
    await act(async () => { finish('synthetic-upload-token'); });

    if (change === 'none') {
      expect(uploads().map(([path]) => path)).toEqual(['/api/teach-me/references', '/api/teach-me/messages']);
      expect(new Headers(uploads()[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-upload-token');
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
      return;
    }

    expect(uploads()).toHaveLength(0);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    if (change === 'account change') {
      act(() => { firebase.changed?.(firebase.auth.currentUser); });
    } else {
      render(<TeachMePage />);
    }
    expect(await screen.findByLabelText(/Comentario/)).toHaveValue('');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(uploads()).toHaveLength(0);
  },
);
