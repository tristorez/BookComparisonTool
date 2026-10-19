import { describe, expect, it } from 'vitest';
import { replay } from '../scripts/replay-merge.js';

/**
 * Regression test on real data: 180 s of live FanDuel (70 in-play markets) recorded on Box A on
 * 2026-10-19, replayed through the connector's MarketMerge and the board's QuoteMerge.
 */
describe('live FanDuel recording replay', () => {
  const { results } = replay();
  const by = (level: string, strategy: string) => results.find((r) => r.level === level && r.strategy === strategy)!;

  it('never moves a shown price backwards, for any strategy', () => {
    for (const r of results) expect(r.flips, `${r.level}/${r.strategy}`).toBe(0);
  });

  it('board merge: shows over 40% of states before push, and almost nothing late', () => {
    const q = by('quote', 'QuoteMerge (board)');
    expect(q.early / q.pushStates).toBeGreaterThan(0.4);
    expect(q.late / q.shown).toBeLessThanOrEqual(0.005);
  });

  it('connector merge: nothing late, and polls lead push hundreds of times', () => {
    const m = by('market', 'MarketMerge (connector)');
    expect(m.late).toBe(0);
    expect(m.early).toBeGreaterThanOrEqual(300);
  });
});
