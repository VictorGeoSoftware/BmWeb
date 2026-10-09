import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Test runner config, deliberately separate from the Next build.
 *
 * Next compiles the app; Vitest only needs to compile the files a test imports.
 * `@vitejs/plugin-react` handles JSX/TSX, and the `@/` alias is mirrored from
 * tsconfig so tests import modules exactly the way the app does — an alias that
 * only resolves in one of the two toolchains is a classic source of
 * "passes in tests, breaks in prod".
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // jsdom is an in-memory DOM. Node-only suites (the upload queue, the API
    // routes) opt out per file with `// @vitest-environment node`, which keeps
    // them faster and stops them accidentally depending on browser globals.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Next's build output and dependencies contain plenty of files matching the
    // include glob patterns of other tools; keep the runner focused on src/.
    exclude: ['node_modules/**', '.next/**'],
    restoreMocks: true,
    clearMocks: true,
  },
});
