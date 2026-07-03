import { describe, it, expect } from 'vitest';
import { parseMoney, extractPrice, computeBudgetTotals } from '../lib/budget-utils.js';

describe('parseMoney', () => {
  it('strips non-digit characters', () => {
    expect(parseMoney('1 250 грн')).toBe(1250);
    expect(parseMoney('₴3,200')).toBe(3200);
  });
  it('returns 0 for empty/non-numeric input', () => {
    expect(parseMoney('')).toBe(0);
    expect(parseMoney('немає ціни')).toBe(0);
    expect(parseMoney(undefined)).toBe(0);
  });
});

describe('extractPrice', () => {
  it('extracts a price with a currency symbol prefix', () => {
    expect(extractPrice('₴1250 за штуку')).toBe('1250 грн');
  });
  it('extracts a price with a "грн" suffix', () => {
    expect(extractPrice('Ціна: 1 250 грн')).toBe('1250 грн');
  });
  it('extracts a price written as UAH', () => {
    expect(extractPrice('3200 UAH')).toBe('3200 грн');
  });
  it('returns empty string when no price is found', () => {
    expect(extractPrice('просто опис без ціни')).toBe('');
    expect(extractPrice('')).toBe('');
  });
});

describe('computeBudgetTotals', () => {
  it('sums planned and paid, computes remaining', () => {
    const items = [{ planned: 1000, paid: 400 }, { planned: 500, paid: 500 }];
    const { planned, paid, remaining } = computeBudgetTotals(items, 0);
    expect(planned).toBe(1500);
    expect(paid).toBe(900);
    expect(remaining).toBe(600);
  });
  it('returns capDiff null when no cap is set', () => {
    expect(computeBudgetTotals([{ planned: 100, paid: 0 }], 0).capDiff).toBeNull();
  });
  it('returns a positive capDiff when under budget', () => {
    expect(computeBudgetTotals([{ planned: 800, paid: 0 }], 1000).capDiff).toBe(200);
  });
  it('returns a negative capDiff when over budget', () => {
    expect(computeBudgetTotals([{ planned: 1200, paid: 0 }], 1000).capDiff).toBe(-200);
  });
  it('treats missing planned/paid fields as 0', () => {
    const { planned, paid } = computeBudgetTotals([{}, { planned: 100 }], 0);
    expect(planned).toBe(100);
    expect(paid).toBe(0);
  });
  it('handles an empty items list', () => {
    const { planned, paid, remaining } = computeBudgetTotals([], 500);
    expect(planned).toBe(0);
    expect(paid).toBe(0);
    expect(remaining).toBe(0);
  });
});
