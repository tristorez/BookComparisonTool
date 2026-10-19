import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const sharedDir = fileURLToPath(new URL('../src/shared', import.meta.url));
const DEFAULT_API_TARGET = 'http://localhost:8080';

/**
 * Where the dev server proxies `/api`. `loadEnv` reads web/.env, web/.env.<mode> (e.g. `.env.remote`)
 * and their `.local` variants; a real environment variable wins over all of them.
 */
function resolveApiTarget(mode: string): string {
  const env = loadEnv(mode, webRoot, 'VITE_');
  const configured = env.VITE_API_TARGET?.trim();
  if (mode === 'remote' && !configured) {
    throw new Error(
      [
        '`npm run dev:remote` needs VITE_API_TARGET: the public URL of a running board server.',
        '  VITE_API_TARGET=https://<board-host> npm run dev:remote',
        'or put `VITE_API_TARGET=https://<board-host>` in web/.env.remote.',
        'The UI then runs on this machine and proxies /api to that server, so it shows live odds',
        'even where the sportsbooks block direct access (e.g. from Canada).',
      ].join('\n'),
    );
  }
  const target = (configured || DEFAULT_API_TARGET).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`VITE_API_TARGET is not a valid URL: "${target}" (expected e.g. https://<board-host>)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`VITE_API_TARGET must be an http(s) URL, got "${target}"`);
  }
  return target;
}

function apiProxy(target: string): Record<string, ProxyOptions> {
  return {
    // The SSE stream. Vite's proxy (http-proxy-3) pipes the upstream body straight to the browser and
    // tears the upstream request down when the browser disconnects; nothing here compresses. Asking
    // upstream for `identity` also keeps every hop past us from buffering the stream for a compressor.
    '/api/stream': { target, changeOrigin: true, headers: { 'accept-encoding': 'identity' } },
    '/api': { target, changeOrigin: true },
  };
}

/** Prints where `/api` goes, so `dev:remote` users can see which board they are looking at. */
function announceProxy(target: string): Plugin {
  return {
    name: 'odds-board:announce-proxy',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        setTimeout(() => server.config.logger.info(`  ➜  API:     /api → ${target}`), 0);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const target = resolveApiTarget(mode);
  const proxy = apiProxy(target);
  return {
    root: webRoot,
    plugins: [react(), tailwindcss(), announceProxy(target)],
    resolve: { alias: { '@shared': sharedDir } },
    // Keep the API server's output visible when both run under `npm run dev` (concurrently).
    clearScreen: false,
    server: { port: 5173, proxy },
    preview: { proxy },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      target: 'es2022',
    },
  };
});
