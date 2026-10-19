import { describe, expect, it } from 'vitest';
import {
  MINUS,
  etDateKey,
  formatAge,
  formatAmerican,
  formatEtDateLabel,
  formatKickoff,
  formatLine,
  formatPrice,
  formatSpread,
  formatTotal,
  nickname,
  priceString,
} from './format';

describe('format', () => {
  it('uses a real minus sign (U+2212)', () => {
    expect(MINUS).toBe('−');
    expect(MINUS.codePointAt(0)).toBe(0x2212);
  });

  it('American odds: +150 / −110', () => {
    expect(formatAmerican(150)).toBe('+150');
    expect(formatAmerican(-110)).toBe('−110');
    expect(formatAmerican(100)).toBe('+100');
    expect(formatAmerican(-100)).toBe('−100');
    expect(formatAmerican(-110)).not.toContain('-'); // never a hyphen-minus
    expect(formatAmerican(Number.NaN)).toBe('—');
  });

  it('spreads: +7.5 / −7.5, PK for zero', () => {
    expect(formatSpread(7.5)).toBe('+7.5');
    expect(formatSpread(-7.5)).toBe('−7.5');
    expect(formatSpread(3)).toBe('+3');
    expect(formatSpread(-3)).toBe('−3');
    expect(formatSpread(0)).toBe('PK');
    expect(formatSpread(-0)).toBe('PK');
    expect(formatSpread(-7.499999999)).toBe('−7.5');
  });

  it('totals: o51.5 / u51.5', () => {
    expect(formatTotal(51.5, 'over')).toBe('o51.5');
    expect(formatTotal(51.5, 'under')).toBe('u51.5');
    expect(formatTotal(44, 'over')).toBe('o44');
  });

  it('moneyline shows odds only', () => {
    expect(formatLine('moneyline', 'home', null)).toBeNull();
    expect(formatLine('moneyline', 'home', -3)).toBeNull();
    expect(formatPrice('moneyline', 'away', null, 145)).toEqual({ line: null, odds: '+145' });
    expect(priceString('moneyline', 'home', null, -170)).toBe('−170');
  });

  it('price strings per market', () => {
    expect(priceString('spread', 'home', -3.5, 100)).toBe('−3.5 +100');
    expect(priceString('spread', 'away', 0, -110)).toBe('PK −110');
    expect(priceString('total', 'over', 51.5, -105)).toBe('o51.5 −105');
    expect(formatLine('spread', 'home', null)).toBeNull();
  });

  it('ages: seconds, minutes, hours, days; clamped at zero', () => {
    expect(formatAge(-500)).toBe('0s');
    expect(formatAge(4_999)).toBe('4s');
    expect(formatAge(59_999)).toBe('59s');
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(2 * 3_600_000)).toBe('2h');
    expect(formatAge(72 * 3_600_000)).toBe('3d');
  });

  it('groups by the US Eastern kickoff date', () => {
    // Monday Night Football: 8:15 pm ET on Oct 26 is already Oct 27 in UTC.
    expect(etDateKey('2026-10-27T00:15:00Z')).toBe('2026-10-26');
    expect(formatEtDateLabel('2026-10-27T00:15:00Z')).toBe('Monday, Oct 26');
    expect(etDateKey('not a date')).toBeNull();
  });

  it('kickoff in the viewer zone, with the weekday when its date differs from the ET date', () => {
    const mnf = '2026-10-27T00:15:00Z';
    // ICU separates AM/PM with a narrow no-break space (U+202F); compare with plain spaces.
    const at = (timeZone: string) => formatKickoff(mnf, { timeZone, locale: 'en-US' }).replace(/\s/g, ' ');
    expect(at('America/New_York')).toBe('8:15 PM');
    expect(at('America/Los_Angeles')).toBe('5:15 PM');
    expect(at('Europe/London')).toBe('Tue 12:15 AM');
    expect(formatKickoff('garbage')).toBe('TBD');
  });

  it('nickname is the last word of the team name', () => {
    expect(nickname('San Francisco 49ers')).toBe('49ers');
    expect(nickname('Washington Commanders')).toBe('Commanders');
  });
});
