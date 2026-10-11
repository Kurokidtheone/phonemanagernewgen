import { CATEGORY_KINDS, CONDITIONS, UNIT_STATUSES, ADJUST_REASONS } from '@shared/schemas';

export { ADJUST_REASONS, CATEGORY_KINDS, CONDITIONS, UNIT_STATUSES };

export type BadgeTone = 'neutral' | 'ok' | 'danger' | 'accent';

export const STATUS_TONE: Record<(typeof UNIT_STATUSES)[number], BadgeTone> = {
  IN_STOCK: 'ok',
  SOLD: 'neutral',
  IN_REPAIR: 'accent',
  RETURNED: 'accent',
  WRITTEN_OFF: 'danger',
};

export const CONDITION_TONE: Record<(typeof CONDITIONS)[number], BadgeTone> = {
  NEW: 'ok',
  USED: 'neutral',
  REFURBISHED: 'accent',
};
