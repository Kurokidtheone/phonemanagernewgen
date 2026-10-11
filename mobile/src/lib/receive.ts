// The purchase being received: scanned phones and counted accessories, kept on the phone until the PC has saved it.
export type Condition = 'NEW' | 'USED' | 'REFURBISHED';

export interface PhoneGroup {
  id: string;
  productId: string;
  label: string;
  condition: Condition;
  /** Centimes, per unit. */
  cost: number;
  salePrice: number;
  imeis: string[];
}
export interface ItemLine {
  productId: string;
  name: string;
  quantity: number;
  unitCost: number;
}
export interface Draft {
  /** One id per purchase: the PC ignores a request it has already saved, so a retry cannot create it twice. */
  requestId: string;
  supplierId: string | null;
  supplierName: string;
  phones: PhoneGroup[];
  items: ItemLine[];
  paid: number;
  note: string;
  /** Name of the invoice photo already uploaded to the PC. */
  invoiceFile: string | null;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const newDraft = (): Draft => ({ requestId: uuid(), supplierId: null, supplierName: '', phones: [], items: [], paid: 0, note: '', invoiceFile: null });

export const phoneCount = (d: Draft): number => d.phones.reduce((n, g) => n + g.imeis.length, 0);
export const isEmpty = (d: Draft): boolean => phoneCount(d) + d.items.length === 0;
export const draftTotal = (d: Draft): number => d.phones.reduce((s, g) => s + g.imeis.length * g.cost, 0) + d.items.reduce((s, l) => s + l.quantity * l.unitCost, 0);
export const hasImei = (d: Draft, imei: string): boolean => d.phones.some((g) => g.imeis.includes(imei));

export function addGroup(d: Draft, group: Omit<PhoneGroup, 'imeis' | 'id'>): { draft: Draft; id: string } {
  const id = uuid();
  return { draft: { ...d, phones: [...d.phones, { ...group, id, imeis: [] }] }, id };
}

/** A valid new IMEI becomes a line. The same IMEI twice in one draft is refused. */
export function addImei(d: Draft, groupId: string, imei: string): Draft {
  if (hasImei(d, imei)) throw new Error('duplicate');
  return { ...d, phones: d.phones.map((g) => (g.id === groupId ? { ...g, imeis: [...g.imeis, imei] } : g)) };
}
export const removeImei = (d: Draft, imei: string): Draft => ({ ...d, phones: d.phones.map((g) => ({ ...g, imeis: g.imeis.filter((i) => i !== imei) })) });
/** Groups with no IMEI are dropped when the purchase is reviewed. */
export const withoutEmptyGroups = (d: Draft): Draft => ({ ...d, phones: d.phones.filter((g) => g.imeis.length > 0) });

/** The same accessory at the same cost adds to its line; at another cost it is another line. */
export function addItem(d: Draft, line: ItemLine): Draft {
  const same = d.items.find((l) => l.productId === line.productId && l.unitCost === line.unitCost);
  return { ...d, items: same ? d.items.map((l) => (l === same ? { ...l, quantity: l.quantity + line.quantity } : l)) : [...d.items, line] };
}
export const removeItem = (d: Draft, index: number): Draft => ({ ...d, items: d.items.filter((_, i) => i !== index) });

/** The body of the purchases.create channel: the same service the desktop uses. */
export function toPurchaseInput(d: Draft, at: Date = new Date()) {
  return {
    supplierId: d.supplierId ?? '',
    date: at.toISOString(),
    paid: d.paid,
    note: d.note,
    requestId: d.requestId,
    invoiceFile: d.invoiceFile,
    itemLines: d.items.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
    phoneLines: d.phones.flatMap((g) => g.imeis.map((imei1) => ({ imei1, imei2: null, condition: g.condition, cost: g.cost, salePrice: g.salePrice, productId: g.productId }))),
  };
}
