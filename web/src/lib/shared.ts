/**
 * Runtime values from the shared contract (`src/shared`). Types are imported from `@shared/*`
 * directly; they are erased at build time.
 *
 * These values come in by relative path because the root `vitest.config.ts` builds its `@shared`
 * alias with `new URL(...).pathname`. That percent-encodes the space in this repo's folder name
 * ("Betstamp%20Technical"), so under vitest `@shared` only resolves for type-only imports.
 * `web/vite.config.ts` resolves the alias correctly. Once the root config uses `fileURLToPath`, this
 * file can re-export from `@shared/wire` and `@shared/domain` instead.
 */
export { cellKey, parseSseId, quoteKey, sseId } from '../../../src/shared/wire';
export { MARKETS, MARKET_SIDES } from '../../../src/shared/domain';
