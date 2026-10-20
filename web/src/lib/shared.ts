/**
 * Runtime values from the shared contract (`src/shared`), re-exported for the web app's modules. Types are
 * imported from `@shared/*` directly; they are erased at build time.
 *
 * `@shared` resolves to `src/shared` in both `web/vite.config.ts` and the root `vitest.config.ts` (each
 * builds the alias with `fileURLToPath`, which keeps the space in this repo's folder name intact), so
 * runtime values come through the alias like everything else.
 */
export { cellKey, parseSseId, quoteKey, sseId } from '@shared/wire';
export { MARKETS, MARKET_SIDES } from '@shared/domain';
