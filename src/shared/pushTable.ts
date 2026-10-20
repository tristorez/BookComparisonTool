import data from './data/nfl-push-table.json' with { type: 'json' };

/**
 * Probability mass of an NFL final margin landing exactly on an integer, near the market line
 * (Decisions.txt D-23). The table is keyed by |k|: it measures a favorite winning by exactly k
 * when the spread is near k, and near pick'em the two directions are treated as symmetric.
 */
export interface PushTable {
  /** P(margin == k). Zero for non-integer k, since half-point lines cannot push. */
  pm(k: number): number;
}

/** Rate for margins past the end of the table (blowouts rarely land exactly on a line). */
const TAIL_RATE = 0.01;

export function createPushTable(rows: readonly { k: number; p: number }[], tailRate = TAIL_RATE): PushTable {
  const byK = new Map(rows.map((r) => [r.k, r.p]));
  return {
    pm(k: number): number {
      if (!Number.isInteger(k)) return 0;
      return byK.get(Math.abs(k)) ?? tailRate;
    },
  };
}

export const NFL_PUSH_TABLE: PushTable = createPushTable(data.table);
