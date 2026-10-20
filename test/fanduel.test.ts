import { describe, expect, it } from 'vitest';
import { FanDuelConnector } from '../src/books/fanduel.js';
import type { Quote } from '../src/books/types.js';

/**
 * FanDuel board refreshes, driven through the real `reconcileBoard` with only the network stubbed:
 * the board page is passed in, and SMP answers every price read with the same prices.
 */
interface BoardInternals {
  running: boolean;
  getJson(url: string): Promise<unknown>;
  reconcileBoard(pages: unknown[], board: unknown): Promise<void>;
  fetchPrices(ids: string[], channel: string): Promise<void>;
}

const NFL = 12282733;
const page = (openDate: string) => ({
  attachments: {
    competitions: { [NFL]: { name: 'NFL' } },
    events: { '100': { eventId: 100, name: 'Pittsburgh Steelers @ New Orleans Saints', openDate, competitionId: NFL } },
    markets: {
      '734.1': {
        marketId: '734.1',
        eventId: 100,
        competitionId: NFL,
        marketType: 'MONEY_LINE',
        runners: [
          { selectionId: 1, runnerName: 'Pittsburgh Steelers', result: { type: 'AWAY' } },
          { selectionId: 2, runnerName: 'New Orleans Saints', result: { type: 'HOME' } },
        ],
      },
    },
  },
});
const prices = [
  {
    marketId: '734.1',
    marketStatus: 'OPEN',
    inplay: false,
    runnerDetails: [
      { selectionId: 1, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: 150 } } },
      { selectionId: 2, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -180 } } },
    ],
  },
];

describe('FanDuel board refresh', () => {
  it('re-prices a rescheduled game under its new key even when the prices did not move', async () => {
    const c = new FanDuelConnector({ push: false, pollIntervalMs: 0 });
    const fd = c as unknown as BoardInternals;
    fd.running = true;
    fd.getJson = async (url) => {
      if (!url.includes('getMarketPrices')) throw new Error(`unexpected request: ${url}`);
      return { data: prices, headers: new Headers(), sentAt: Date.now(), receivedAt: Date.now() };
    };
    const shown = () => c.snapshot().quotes.map((q: Quote) => `${q.gameKey} ${q.side} ${q.american}`).sort();

    const sunday = page('2026-10-25T17:00:00.000Z');
    await fd.reconcileBoard([sunday], sunday);
    expect(shown()).toEqual(['2026-10-25:PIT@NO away 150', '2026-10-25:PIT@NO home -180']);

    // Moved to Monday: the old key is retired and the same prices must reappear under the new one.
    const monday = page('2026-10-26T17:00:00.000Z');
    await fd.reconcileBoard([monday], monday);
    expect(c.snapshot().games.map((g) => g.gameKey)).toEqual(['2026-10-26:PIT@NO']);
    expect(shown()).toEqual(['2026-10-26:PIT@NO away 150', '2026-10-26:PIT@NO home -180']);

    await fd.fetchPrices(['734.1'], 'poll');
    expect(shown()).toEqual(['2026-10-26:PIT@NO away 150', '2026-10-26:PIT@NO home -180']);
    fd.running = false;
  });
});
