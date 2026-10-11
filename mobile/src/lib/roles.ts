// Which tabs each role sees. The PC refuses anything outside the role anyway; this only keeps the screens honest.
import type { MobileRole } from '@shared/schemas';

export type TabId = 'home' | 'sell' | 'stock' | 'repairs' | 'lookup' | 'customers' | 'more';

export const TABS: Record<MobileRole, TabId[]> = {
  OWNER: ['home', 'sell', 'stock', 'repairs', 'more'],
  SELLER: ['sell', 'lookup', 'customers', 'more'],
  TECHNICIAN: ['repairs', 'lookup', 'more'],
  STOCK: ['stock', 'lookup', 'more'],
};
// "More" (device name, language, connection, Pair again) is on every role's bar: the spec's tab lists name
// the working tabs, and every device needs a way to reach those settings.

export const ACCENT: Record<TabId, string> = {
  home: 'teal', sell: 'blue', stock: 'green', repairs: 'orange', lookup: 'green', customers: 'purple', more: 'olive',
};
