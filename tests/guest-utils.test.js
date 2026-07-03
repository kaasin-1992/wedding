import { describe, it, expect } from 'vitest';
import { normName, canon, lev, similarTok, findDuplicateGuest, headCount, totalPeople, peopleAt, applyFilter, guestRank, matchesAllFilters } from '../lib/guest-utils.js';

describe('normName', () => {
  it('lowercases, strips punctuation and extra spaces', () => {
    expect(normName("  Іван  Петров'ич  ")).toBe('іван петрович');
    expect(normName(undefined)).toBe('');
  });
});

describe('lev (Levenshtein distance)', () => {
  it('handles identical strings', () => { expect(lev('саша', 'саша')).toBe(0); });
  it('handles empty strings', () => { expect(lev('', 'abc')).toBe(3); expect(lev('abc', '')).toBe(3); });
  it('counts edits correctly', () => { expect(lev('катя', 'катю')).toBe(1); });
});

describe('similarTok', () => {
  it('matches identical tokens', () => { expect(similarTok('саша', 'саша')).toBe(true); });
  it('matches prefix relationship for tokens length >= 3', () => { expect(similarTok('олександр', 'олекс')).toBe(true); });
  it('matches near-identical tokens above 0.8 similarity', () => { expect(similarTok('дмитро', 'дмітро')).toBe(true); });
  it('rejects near-identical short tokens below 0.8 similarity', () => { expect(similarTok('катя', 'катю')).toBe(false); });
  it('rejects dissimilar tokens', () => { expect(similarTok('андрій', 'марія')).toBe(false); });
  it('rejects empty input', () => { expect(similarTok('', 'a')).toBe(false); });
});

describe('canon (nickname canonicalization)', () => {
  it('maps nicknames from the same group to the same canonical token', () => {
    expect(canon('саша')).toBe(canon('сашко'));
    expect(canon('олександр')).toBe(canon('санько'));
  });
  it('leaves unknown tokens untouched', () => {
    expect(canon('невідомеім\'я')).toBe('невідомеім\'я');
  });
});

describe('findDuplicateGuest', () => {
  it('finds an exact name match', () => {
    const list = [{ name: 'Олена Коваль' }];
    expect(findDuplicateGuest('олена коваль', list)).toBe('Олена Коваль');
  });
  it('finds a nickname-variant match (Ukrainian diminutive)', () => {
    const list = [{ name: 'Олександр Ковальчук' }];
    expect(findDuplicateGuest('Саша Ковальчук', list)).toBe('Олександр Ковальчук');
  });
  it('finds a fuzzy-typo match (one-letter typo, not a known nickname)', () => {
    const list = [{ name: 'Дмитро Петренко' }];
    expect(findDuplicateGuest('Дмітро Петренко', list)).toBe('Дмитро Петренко');
  });
  it('returns null when no guest matches', () => {
    expect(findDuplicateGuest('Хтось Новий', [{ name: 'Інша Людина' }])).toBeNull();
  });
  it('returns null for an empty guest list', () => {
    expect(findDuplicateGuest('Будь-хто', [])).toBeNull();
  });
});

describe('headCount', () => {
  it('counts the guest plus a confirmed plus-one plus kids', () => {
    expect(headCount({ plus1: 'confirmed', kids: 2 })).toBe(4);
  });
  it('does not count a non-confirmed plus-one', () => {
    expect(headCount({ plus1: 'none', kids: 0 })).toBe(1);
    expect(headCount({ plus1: 'invited', kids: 0 })).toBe(1);
  });
});

describe('totalPeople / peopleAt', () => {
  const guests = [
    { status: 'confirmed', plus1: 'confirmed', kids: 1, event: 'ceremony' },
    { status: 'confirmed', plus1: 'none', kids: 0, event: 'party' },
    { status: 'declined', plus1: 'confirmed', kids: 5, event: 'both' },
  ];
  it('excludes declined guests from the total', () => {
    expect(totalPeople(guests)).toBe(3 + 1); // (1+1+1) + (1)
  });
  it('filters by event, including "both"', () => {
    expect(peopleAt(guests, 'ceremony')).toBe(3);
    expect(peopleAt(guests, 'party')).toBe(1);
  });
  it('returns 0 for an empty list', () => {
    expect(totalPeople([])).toBe(0);
    expect(peopleAt([], 'ceremony')).toBe(0);
  });
});

describe('applyFilter', () => {
  const g = { side: 'her', group: 'family', event: 'both', plus1: 'confirmed', maybe: true, backup: false, wparty: true, status: 'pending' };
  it('all always matches', () => { expect(applyFilter(g, 'all')).toBe(true); });
  it('matches side/group/event/plus1/maybe/wparty/pending filters', () => {
    expect(applyFilter(g, 'her')).toBe(true);
    expect(applyFilter(g, 'his')).toBe(false);
    expect(applyFilter(g, 'family')).toBe(true);
    expect(applyFilter(g, 'ceremony')).toBe(true);
    expect(applyFilter(g, 'party')).toBe(true);
    expect(applyFilter(g, 'plus1')).toBe(true);
    expect(applyFilter(g, 'maybe')).toBe(true);
    expect(applyFilter(g, 'backup')).toBe(false);
    expect(applyFilter(g, 'wparty')).toBe(true);
    expect(applyFilter(g, 'pending')).toBe(true);
  });
  it('defaults group to "friends" when unset', () => {
    expect(applyFilter({ group: undefined }, 'friends')).toBe(true);
  });
});

describe('guestRank', () => {
  it('orders confirmed < pending < maybe < backup < declined', () => {
    expect(guestRank({ status: 'confirmed' })).toBe(0);
    expect(guestRank({ status: 'pending' })).toBe(1);
    expect(guestRank({ status: 'pending', maybe: true })).toBe(2);
    expect(guestRank({ status: 'pending', backup: true })).toBe(3);
    expect(guestRank({ status: 'declined' })).toBe(4);
  });
});

describe('matchesAllFilters (мультифільтри: АБО в межах категорії, І між категоріями)', () => {
  const her = { side: 'her', group: 'family', event: 'ceremony', plus1: 'none', maybe: false, backup: false, wparty: false, status: 'confirmed' };
  const his = { side: 'his', group: 'friends', event: 'party', plus1: 'confirmed', maybe: true, backup: false, wparty: false, status: 'pending' };

  it('empty selection or "all" matches everyone', () => {
    expect(matchesAllFilters(her, new Set())).toBe(true);
    expect(matchesAllFilters(his, new Set(['all']))).toBe(true);
  });

  it('single filter behaves like applyFilter', () => {
    expect(matchesAllFilters(her, new Set(['her']))).toBe(true);
    expect(matchesAllFilters(his, new Set(['her']))).toBe(false);
  });

  it('combines two filters from different categories with AND', () => {
    expect(matchesAllFilters(her, new Set(['her', 'ceremony']))).toBe(true);
    expect(matchesAllFilters(her, new Set(['her', 'party']))).toBe(false);
  });

  it('combines two filters from the same category with OR', () => {
    const bothSides = new Set(['her', 'his']);
    expect(matchesAllFilters(her, bothSides)).toBe(true);
    expect(matchesAllFilters(his, bothSides)).toBe(true);
  });

  it('a same-category OR still narrows against another AND-ed category', () => {
    const filters = new Set(['her', 'his', 'ceremony']); // (her OR his) AND ceremony
    expect(matchesAllFilters(her, filters)).toBe(true);   // her, ceremony
    expect(matchesAllFilters(his, filters)).toBe(false);  // his, but party not ceremony
  });

  it('standalone filters (plus1/maybe/backup/wparty/pending) AND with everything else', () => {
    expect(matchesAllFilters(his, new Set(['his', 'maybe', 'plus1']))).toBe(true);
    expect(matchesAllFilters(his, new Set(['his', 'maybe', 'backup']))).toBe(false);
  });
});
