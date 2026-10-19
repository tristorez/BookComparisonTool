import { describe, expect, it } from 'vitest';
import { americanToDecimal, compareForBettor } from './odds';

describe('americanToDecimal', () => {
  it('converts both signs', () => {
    expect(americanToDecimal(150)).toBe(2.5);
    expect(americanToDecimal(-200)).toBe(1.5);
    expect(americanToDecimal(-110)).toBeCloseTo(1.90909, 5);
    expect(americanToDecimal(100)).toBe(americanToDecimal(-100));
  });
});

describe('compareForBettor (flash color)', () => {
  const p = (line: number | null, american: number) => ({ line, american });

  it('same line: the higher payout is better', () => {
    expect(compareForBettor('moneyline', 'home', p(null, 140), p(null, 150))).toBe(1);
    expect(compareForBettor('moneyline', 'away', p(null, -110), p(null, -120))).toBe(-1);
    expect(compareForBettor('spread', 'home', p(-3, -110), p(-3, -105))).toBe(1);
    expect(compareForBettor('moneyline', 'home', p(null, 100), p(null, -100))).toBe(0);
  });

  it('spread: more points taken or fewer laid is better, whatever the price', () => {
    expect(compareForBettor('spread', 'home', p(-3.5, 100), p(-3, -120))).toBe(1);
    expect(compareForBettor('spread', 'away', p(3.5, -120), p(3, 100))).toBe(-1);
    expect(compareForBettor('spread', 'away', p(-0.5, -110), p(0.5, -130))).toBe(1);
  });

  it('totals: lower is better for the over, higher for the under', () => {
    expect(compareForBettor('total', 'over', p(51.5, -110), p(51, -115))).toBe(1);
    expect(compareForBettor('total', 'over', p(51.5, -110), p(52, 100))).toBe(-1);
    expect(compareForBettor('total', 'under', p(51.5, -110), p(52, -115))).toBe(1);
    expect(compareForBettor('total', 'under', p(51.5, -110), p(51, 100))).toBe(-1);
  });
});
