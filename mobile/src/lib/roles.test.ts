import { expect, it } from 'vitest';
import { TABS } from './roles';

it('shows each role its tabs', () => {
  expect(TABS.OWNER).toEqual(['home', 'sell', 'stock', 'repairs', 'more']);
  expect(TABS.SELLER.slice(0, 3)).toEqual(['sell', 'lookup', 'customers']);
  expect(TABS.TECHNICIAN.slice(0, 2)).toEqual(['repairs', 'lookup']);
  expect(TABS.STOCK.slice(0, 2)).toEqual(['stock', 'lookup']);
  for (const tabs of Object.values(TABS)) expect(tabs.at(-1)).toBe('more');
});
