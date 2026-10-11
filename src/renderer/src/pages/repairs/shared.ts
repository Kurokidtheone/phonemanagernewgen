import { OPEN_REPAIR_STATUSES, REPAIR_STATUSES } from '@shared/schemas';

export { OPEN_REPAIR_STATUSES, REPAIR_STATUSES };
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const STATUS_TONE: Record<RepairStatus, 'neutral' | 'ok' | 'danger' | 'accent'> = {
  RECEIVED: 'neutral',
  DIAGNOSING: 'accent',
  WAITING_PARTS: 'accent',
  READY: 'ok',
  DELIVERED: 'ok',
  CANCELLED: 'danger',
  UNREPAIRABLE: 'danger',
};
