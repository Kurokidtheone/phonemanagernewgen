// The one file that defines what this product is. Change it with
// `npm run new-product`, or by hand, then rename the sections you need.

export const APP = {
  /** Shown in the window title and on printed documents. */
  name: 'Phone Store Manager',
  /** 2-5 capital letters. Part of every license key: a key for another product is rejected. */
  productCode: 'PSM',
  /** Folder name for user data and file name of the database. */
  slug: 'phone-store-manager',
  trialDays: 14,
  /**
   * The Supabase project used as a mailbox for access from outside the shop (see supabase/README.md).
   * Both values are public by design. Never put the service_role key here.
   */
  remote: {
    url: 'https://ggkevpmjabokmgkcdhzx.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdna2V2cG1qYWJva21na2NkaHp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MjE5NjYsImV4cCI6MjEwNzE5Nzk2Nn0.uZugUM1HLSykqIguNXdTbzaO3ZbGlqpfKHDq2C0lORA',
  },
  currency: { ar: 'دج', latin: 'DA' },
  /** Who built the app: shown in About, the phone number opens WhatsApp. */
  developer: { name: 'Next Level Dev Labs', phone: '0562139732' },
} as const;

export type Accent = 'teal' | 'blue' | 'purple' | 'orange' | 'green' | 'pink' | 'neutral' | 'olive';

export interface SectionDef {
  id: string;
  path: string;
  accent: Accent;
  /** Can the manager password protect it? Overview must stay open. */
  lockable: boolean;
}

// Order = order in the bottom bar. The Lock tab (neutral) sits before Settings and is not a page:
// it opens a menu, see components/BottomBar.tsx.
// Labels live in the i18n files under "sections.<id>".
// Icons live in src/renderer/src/lib/sections.tsx.
export const SECTIONS = [
  { id: 'overview', path: '/', accent: 'teal', lockable: false },
  { id: 'sell', path: '/sell', accent: 'blue', lockable: true },
  { id: 'stock', path: '/stock', accent: 'green', lockable: true },
  { id: 'repairs', path: '/repairs', accent: 'orange', lockable: true },
  { id: 'people', path: '/people', accent: 'purple', lockable: true },
  { id: 'finance', path: '/finance', accent: 'pink', lockable: true },
  { id: 'settings', path: '/settings', accent: 'olive', lockable: true },
] as const satisfies readonly SectionDef[];

export type SectionId = (typeof SECTIONS)[number]['id'];
export const SECTION_IDS = SECTIONS.map((s) => s.id) as [SectionId, ...SectionId[]];
export const LOCKABLE_SECTIONS = SECTIONS.filter((s) => s.lockable).map((s) => s.id) as SectionId[];

export const LANGUAGES = ['ar', 'fr', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
