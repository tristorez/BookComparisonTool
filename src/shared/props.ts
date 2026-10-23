/**
 * Player props: the vocabulary the connectors, the server and the browser share. Browser-safe: no Node
 * imports. Each book maps its own market names onto these stats, so the game page lines the books up by
 * stat and player. Props are read on demand for the game page (src/server/props.ts), not streamed.
 */
import type { MarketType, Side } from './domain.js';

/** The game page's prop tabs, in display order. Each is one read per book (an FD event-page tab, a DK category). */
export const PROP_GROUPS = ['passing', 'rushing', 'receiving', 'touchdowns'] as const;
export type PropGroup = (typeof PROP_GROUPS)[number];

/** `ou`: over or under the player's line. `yes`: one price that the player does it (scorer markets). */
export type PropKind = 'ou' | 'yes';
export type PropSide = 'over' | 'under' | 'yes';

export const PROP_SIDES: Readonly<Record<PropKind, readonly PropSide[]>> = { ou: ['over', 'under'], yes: ['yes'] };

/**
 * Each prop side in the board's market terms, so props rank, flash and format with the board's own code
 * (bestPrice.ts, compareForBettor, formatPrice): an over/under is a total, and a scorer price is a
 * moneyline (payout only), whose `home` side stands in for "yes".
 */
export const PROP_SIDE_TERMS: Readonly<Record<PropSide, { market: MarketType; side: Side }>> = {
  over: { market: 'total', side: 'over' },
  under: { market: 'total', side: 'under' },
  yes: { market: 'moneyline', side: 'home' },
};

interface PropStatSpec {
  group: PropGroup;
  kind: PropKind;
  label: string;
}

/**
 * Every full-game stat we read, in display order within each group. Milestone ladders ("250+ yards"),
 * alt lines, halves and quarters are left out: they are separate markets at both books.
 */
export const PROP_STATS = {
  pass_yds: { group: 'passing', kind: 'ou', label: 'Passing Yards' },
  pass_tds: { group: 'passing', kind: 'ou', label: 'Passing TDs' },
  pass_cmp: { group: 'passing', kind: 'ou', label: 'Completions' },
  pass_att: { group: 'passing', kind: 'ou', label: 'Pass Attempts' },
  pass_int: { group: 'passing', kind: 'ou', label: 'Interceptions' },
  pass_rush_yds: { group: 'passing', kind: 'ou', label: 'Pass + Rush Yards' },
  pass_long: { group: 'passing', kind: 'ou', label: 'Longest Completion' },
  rush_yds: { group: 'rushing', kind: 'ou', label: 'Rushing Yards' },
  rush_att: { group: 'rushing', kind: 'ou', label: 'Rush Attempts' },
  rush_rec_yds: { group: 'rushing', kind: 'ou', label: 'Rush + Rec Yards' },
  rush_long: { group: 'rushing', kind: 'ou', label: 'Longest Rush' },
  rec_yds: { group: 'receiving', kind: 'ou', label: 'Receiving Yards' },
  receptions: { group: 'receiving', kind: 'ou', label: 'Receptions' },
  rec_long: { group: 'receiving', kind: 'ou', label: 'Longest Reception' },
  td_anytime: { group: 'touchdowns', kind: 'yes', label: 'Anytime TD Scorer' },
  td_first: { group: 'touchdowns', kind: 'yes', label: 'First TD Scorer' },
  td_last: { group: 'touchdowns', kind: 'yes', label: 'Last TD Scorer' },
  td_2plus: { group: 'touchdowns', kind: 'yes', label: '2+ Touchdowns' },
} as const satisfies Record<string, PropStatSpec>;

export type PropStat = keyof typeof PROP_STATS;

export const isPropGroup = (v: unknown): v is PropGroup => typeof v === 'string' && (PROP_GROUPS as readonly string[]).includes(v);

/**
 * Cross-book player identity. The books disagree on punctuation and suffixes ("A.J. Barner" vs "AJ
 * Barner", "Kenneth Walker III" vs "Kenneth Walker"), so the key drops accents, periods, apostrophes and
 * a trailing generational suffix, and joins spaced initials ("A. J. Brown" is "AJ Brown").
 */
export function playerKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b([a-z]) (?=[a-z]\b)/g, '$1')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, '');
}
