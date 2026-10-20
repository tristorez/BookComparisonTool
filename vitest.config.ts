import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Two projects: the server's tests in Node, the web app's in jsdom with its `@shared` alias.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'server', environment: 'node', include: ['test/**/*.test.ts'] },
      },
      {
        plugins: [react()],
        // fileURLToPath, not URL.pathname: the latter percent-encodes the space in this repo's folder name.
        resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
        test: { name: 'web', environment: 'jsdom', include: ['web/src/**/*.test.{ts,tsx}'] },
      },
    ],
  },
});
