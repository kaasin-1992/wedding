import { describe, it, expect, beforeAll } from 'vitest';
import { hashStr, isWeed, getStatus, plDays, timeMask, timeNorm, daysUntilWedding } from '../lib/task-utils.js';

describe('hashStr (smoke test — validates the dual-export pattern)', () => {
  it('returns a stable hash string', () => {
    expect(hashStr('привіт')).toBe(hashStr('привіт'));
    expect(typeof hashStr('a')).toBe('string');
  });
});

describe('isWeed', () => {
  it('detects weed-related text in Ukrainian and English', () => {
    expect(isWeed('косяк на вечірці')).toBe(true);
    expect(isWeed('weed')).toBe(true);
    expect(isWeed('🌿')).toBe(true);
  });
  it('does not false-positive on unrelated words containing "трав"', () => {
    expect(isWeed('травень')).toBe(false);
    expect(isWeed('квіти і трави для декору')).toBe(true); // "трави" саме має спрацювати
  });
  it('ignores empty/undefined input', () => {
    expect(isWeed('')).toBe(false);
    expect(isWeed(undefined)).toBe(false);
  });
});

describe('getStatus', () => {
  it('returns done when task is done regardless of deadline', () => {
    expect(getStatus({ done: true, deadline: '2000-01-01' })).toBe('done');
  });
  it('returns asap when asap and no deadline', () => {
    expect(getStatus({ done: false, asap: true, deadline: null })).toBe('asap');
  });
  it('returns ok when no deadline and not asap', () => {
    expect(getStatus({ done: false, deadline: null })).toBe('ok');
  });
  it('returns hot when overdue', () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    expect(getStatus({ done: false, deadline: past })).toBe('hot');
  });
  it('returns hot when due within 7 days', () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    expect(getStatus({ done: false, deadline: soon })).toBe('hot');
  });
  it('returns warn when due within 8-21 days', () => {
    const later = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    expect(getStatus({ done: false, deadline: later })).toBe('warn');
  });
  it('returns ok when due beyond 21 days', () => {
    const farOut = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    expect(getStatus({ done: false, deadline: farOut })).toBe('ok');
  });
});

describe('plDays (українська плюралізація)', () => {
  it('handles 1 день', () => { expect(plDays(1)).toBe('день'); });
  it('handles 2-4 дні', () => { expect(plDays(2)).toBe('дні'); expect(plDays(4)).toBe('дні'); });
  it('handles 5-20 днів', () => { expect(plDays(5)).toBe('днів'); expect(plDays(11)).toBe('днів'); });
  it('handles 21 день (виняток після 11-19)', () => { expect(plDays(21)).toBe('день'); });
  it('handles 0 днів', () => { expect(plDays(0)).toBe('днів'); });
});

describe('timeMask / timeNorm', () => {
  it('masks digits into HH:MM as user types', () => {
    expect(timeMask('1830')).toBe('18:30');
    expect(timeMask('9')).toBe('9');
    expect(timeMask('183')).toBe('18:3');
  });
  it('normalizes valid time strings', () => {
    expect(timeNorm('9:05')).toBe('09:05');
    expect(timeNorm('18:30')).toBe('18:30');
  });
  it('rejects invalid hour/minute', () => {
    expect(timeNorm('25:00')).toBe('');
    expect(timeNorm('12:60')).toBe('');
    expect(timeNorm('not a time')).toBe('');
  });
});

describe('daysUntilWedding', () => {
  beforeAll(() => {
    // дата без часової частини (як today() її й порівнює), щоб різниця була рівно 10 днів
    globalThis.WEDDING = new Date(new Date(Date.now() + 10 * 86400000).toDateString());
  });
  it('computes days remaining based on the global WEDDING date', () => {
    expect(daysUntilWedding()).toBe(10);
  });
});
