import type { BookId } from '@shared/domain';
import type { WireQuote } from '@shared/wire';

/**
 * Board-wide inputs to the client-side eligibility check. Kept as one cached object in the store so
 * cells re-render only when a book's staleness or the stream's connectivity actually flips.
 */
export interface Eligibility {
  /** The stream has been down past the grace period: every price on screen is stale. */
  disconnected: boolean;
  /** Books whose status says stale (every feed for the book is stale). */
  stale: ReadonlySet<BookId>;
}

export type IneligibleTag = 'stale' | 'suspended' | 'pre-game line' | 'check';

export interface Ineligibility {
  /** In display priority: the first one is the visible tag. */
  tags: readonly IneligibleTag[];
  reasons: readonly string[];
}

export const ELIGIBLE: Ineligibility = Object.freeze({ tags: Object.freeze([]), reasons: Object.freeze([]) });

export interface EligibilityInput {
  quote: Pick<WireQuote, 'suspended' | 'live'> | undefined;
  book: BookId;
  bookName: string;
  gameLive: boolean;
  gameSuspect: boolean;
  elig: Eligibility;
}

/**
 * Mirrors the board's Best Price eligibility (not suspended, book not stale, not a pre-game line on a
 * live game, game not suspect) and adds "the stream is down", so the screen never presents a price as
 * current when it can't vouch for it.
 */
export function ineligibility(input: EligibilityInput): Ineligibility {
  const { quote, book, bookName, gameLive, gameSuspect, elig } = input;
  const tags: IneligibleTag[] = [];
  const reasons: string[] = [];
  if (elig.disconnected) {
    tags.push('stale');
    reasons.push('the connection to the odds server is down, so this price may be out of date');
  } else if (elig.stale.has(book)) {
    tags.push('stale');
    reasons.push(`${possessive(bookName)} feed is stale`);
  }
  if (quote?.suspended) {
    tags.push('suspended');
    reasons.push(`${bookName} has suspended betting on this market`);
  }
  if (quote && gameLive && !quote.live) {
    tags.push('pre-game line');
    reasons.push(`this is ${possessive(bookName)} pre-game line and the game is live`);
  }
  if (gameSuspect) {
    tags.push('check');
    reasons.push('the books disagree sharply on this game (possible mapping error)');
  }
  return tags.length === 0 ? ELIGIBLE : { tags, reasons };
}

/** "FanDuel's", "DraftKings'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function ineligibleTooltip(x: Ineligibility): string {
  return `Not used for Best Price: ${x.reasons.join('; ')}.`;
}
