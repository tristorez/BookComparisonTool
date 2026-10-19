import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'server', environment: 'node', include: ['test/**/*.test.ts'] },
      },
      {
        plugins: [react()],
        resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
        test: { name: 'web', environment: 'jsdom', include: ['web/src/**/*.test.{ts,tsx}'] },
      },
    ],
  },
});
