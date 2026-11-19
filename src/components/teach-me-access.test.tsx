import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TeachMePage from '@/app/dashboard/teach-me/page';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { authFetch } from '@/lib/api-client';

const state = vi.hoisted(() => ({ isQA: true, path: '/dashboard' }));
vi.mock('@/lib/env', () => ({ get isQA() { return state.isQA; } }));
vi.mock('next/navigation', () => ({ usePathname: () => state.path }));
vi.mock('@/lib/api-client', () => ({ authFetch: vi.fn() }));

const fetchAccess = vi.mocked(authFetch);
const sidebar = () => <SidebarProvider><AppSidebar /></SidebarProvider>;

beforeEach(() => {
  state.isQA = true;
  state.path = '/dashboard';
  fetchAccess.mockReset();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => vi.unstubAllGlobals());

it('shows the sidebar link only after a grant and removes it on a denied navigation check', async () => {
  fetchAccess.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const view = render(sidebar());
  expect(screen.queryByRole('link', { name: 'Enséñame' })).not.toBeInTheDocument();
  expect(await screen.findByRole('link', { name: 'Enséñame' })).toHaveAttribute('href', '/dashboard/teach-me');

  fetchAccess.mockResolvedValueOnce(new Response(null, { status: 403 }));
  state.path = '/dashboard/price-proposals';
  view.rerender(sidebar());
  await waitFor(() => expect(fetchAccess).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('link', { name: 'Enséñame' })).not.toBeInTheDocument();
});

it('checks direct visits before rendering the QA page', async () => {
  fetchAccess.mockResolvedValue(new Response(null, { status: 204 }));
  render(<TeachMePage />);
  expect(screen.getByRole('status')).toHaveTextContent('Comprobando acceso');
  expect(await screen.findByRole('heading', { name: 'Enséñame' })).toBeVisible();
  expect(screen.getByText('QA')).toBeVisible();
});

it('does not render a denied direct visit', async () => {
  fetchAccess.mockResolvedValue(new Response(null, { status: 403 }));
  render(<TeachMePage />);
  expect(await screen.findByText(/no está disponible/)).toBeVisible();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
});

it('does not render the page when the access check fails', async () => {
  fetchAccess.mockRejectedValue(new Error('offline'));
  render(<TeachMePage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo comprobar el acceso');
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
});

it('does not check or display access outside QA', () => {
  state.isQA = false;
  render(<>{sidebar()}<TeachMePage /></>);
  expect(screen.queryByRole('link', { name: 'Enséñame' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Enséñame' })).not.toBeInTheDocument();
  expect(fetchAccess).not.toHaveBeenCalled();
});
