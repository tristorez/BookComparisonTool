import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { sseId } from './lib/shared';
import { StoreContext } from './lib/store';
import { StreamClient } from './lib/stream';
import { BOOT, delta, fakeEventSources, heartbeat, manualStore, pick, quote, snapshot } from './test/fixtures';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('App end to end (fake EventSource → stream → store → board)', () => {
  it('renders the snapshot, flashes a live move, and goes stale when the stream drops', () => {
    const store = manualStore();
    const es = fakeEventSources();
    const client = new StreamClient({ store, createEventSource: es.factory, visibilityTarget: null, isHidden: () => false, log: () => {} });
    client.start();
    const { container } = render(
      <StoreContext value={store}>
        <App />
      </StoreContext>,
    );
    expect(screen.getByText('Connecting to live odds…')).toBeTruthy();

    const source = es.last();
    act(() => {
      source.open();
      source.emit(
        'snapshot',
        snapshot({ quotes: [quote('draftkings'), quote('fanduel', { line: -3.5, american: 100 })], bests: [pick({ exact: false, rule: 'R3', reason: 'r' })] }),
        sseId(BOOT, 10),
      );
      source.emit('hb', heartbeat(10));
      store.flush();
    });
    expect(screen.getByRole('article', { name: 'Pittsburgh Steelers at New Orleans Saints' })).toBeTruthy();
    expect(container.querySelector('[data-connection]')!.textContent).toBe('Live');
    expect(container.querySelector('[data-method]')!.textContent).toBe('est.');
    expect(container.querySelector('[data-flash]')).toBeNull();

    act(() => {
      source.emit(
        'delta',
        delta(11, {
          quotes: [quote('draftkings', { american: -105, prev: { american: -110, line: -3, at: Date.now() } })],
          bests: [pick({ american: -105, exact: false, rule: 'R3', reason: 'r' })],
        }),
        sseId(BOOT, 11),
      );
      store.flush();
    });
    expect(container.querySelector('[data-cell="best"] [data-flash="up"]')).not.toBeNull();

    act(() => {
      source.fail(true); // e.g. a 502 during a deploy
      store.flush();
    });
    expect(container.querySelector('[data-connection]')!.textContent).toBe('Reconnecting…');
    expect(container.querySelector('[data-stale-banner]')!.textContent).toContain('Reconnecting to the odds server — showing last known prices');
    expect(container.querySelectorAll('[data-ineligible="stale"]').length).toBeGreaterThan(0);
    client.stop();
  });
});
