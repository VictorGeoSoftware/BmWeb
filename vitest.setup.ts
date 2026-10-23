import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Global test setup, applied to every suite via `vitest.config.ts`.
 *
 * Two jobs: extend `expect` with DOM matchers, and undo anything a test leaves
 * behind in the shared jsdom document or on globals. Leaked state between tests
 * is the main reason web suites become order-dependent and flaky.
 */

afterEach(() => {
  // Unmounts anything RTL rendered. Without this, a second render() in the same
  // file finds two matching elements and `getByRole` throws "found multiple".
  cleanup();
});

/**
 * jsdom implements layout as no-ops, so a few browser APIs used by the Radix
 * primitives behind shadcn/ui simply do not exist. Stubbing them here rather
 * than in each test keeps component suites focused on behaviour.
 *
 * This setup file also runs for suites that opt into the `node` environment,
 * where there is no `window` at all — hence the guard.
 */
const isBrowserLike = typeof window !== 'undefined';

if (isBrowserLike && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

if (isBrowserLike && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom does not implement scrollIntoView; Radix calls it when focusing items.
if (isBrowserLike && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
