import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PriceCell } from '../components/PriceCell';
import { GAME, delta, manualStore, quote, snapshot } from '../test/fixtures';
import { StoreContext } from './store';

type ActEnv = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

afterEach(() => {
  (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;
  cleanup();
});

describe('paint timing', () => {
  it('a microtask queued after the store flush runs after React committed that frame', async () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')] }));
    const { container } = render(
      <StoreContext value={store}>
        <PriceCell game={GAME} market="spread" side="home" view="draftkings" gameLive={false} gameSuspect={false} />
      </StoreContext>,
    );
    const text = () => container.querySelector('[data-price]')?.textContent;
    expect(text()).toBe('−3 −110');

    // Real scheduling, as in the browser: no act() batching.
    (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = false;
    let seenInFlush: string | null | undefined;
    let seenInMicrotask: string | null | undefined;
    store.applyDelta(delta(11, { quotes: [quote('draftkings', { american: -105 })] }));
    store.afterFlush(() => {
      seenInFlush = text();
      queueMicrotask(() => {
        seenInMicrotask = text();
      });
    });
    store.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(seenInFlush).toBe('−3 −110'); // listeners notified, React not yet committed
    expect(seenInMicrotask).toBe('−3 −105'); // committed
  });
});
