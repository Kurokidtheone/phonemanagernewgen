import { House, Package, Settings, ShoppingCart, Users, Wallet, Wrench, type LucideIcon } from 'lucide-react';
import type { SectionId } from '@shared/app.config';

// One icon per section id from src/shared/app.config.ts.
export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  overview: House,
  sell: ShoppingCart,
  stock: Package,
  repairs: Wrench,
  people: Users,
  finance: Wallet,
  settings: Settings,
};

// Sub-tab chips of each section. Labels are i18n keys "tabs.<section>.<tab>".
export const SECTION_TABS = {
  sell: ['newSale', 'history', 'returns', 'review'],
  stock: ['phones', 'items', 'purchases', 'suppliers', 'counts'],
  repairs: ['board', 'tickets'],
  people: ['customers', 'employees'],
} as const;
