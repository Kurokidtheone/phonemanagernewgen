// Zod schemas shared by the main process (IPC validation) and the renderer (forms).
import { z } from 'zod';
import { LANGUAGES, SECTION_IDS, THEMES } from './app.config';

export const publicSettingsSchema = z.object({
  storeName: z.string().max(120),
  ownerName: z.string().max(120),
  phone: z.string().max(40),
  address: z.string().max(200),
  logoFile: z.string().nullable(),
  language: z.enum(LANGUAGES),
  theme: z.enum(THEMES),
  receiptSize: z.enum(['80mm', 'A5']),
  receiptFooter: z.string().max(400),
  /** Printer for receipts and slips a phone sends to the counter. Empty: the system default printer. */
  receiptPrinter: z.string().max(200),
  labelSize: z.enum(['40x25', '50x30']),
  allowNegativeStock: z.boolean(),
  autoPrintReceipt: z.boolean(),
  debtDueDays: z.number().int().min(0).max(3650),
  repairTerms: z.string().max(400),
  askSeller: z.boolean(),
  /** Copies of the repair intake slip: 1 customer, 2 + shop, 3 + one to keep with the device. */
  slipCopies: z.number().int().min(1).max(3),
  /** Default warranty (days) for new phones, used phones and accessories. */
  warrantyNewDays: z.number().int().min(0).max(3650),
  warrantyUsedDays: z.number().int().min(0).max(3650),
  warrantyAccessoryDays: z.number().int().min(0).max(3650),
  /** While Finance is locked, the main process strips costs and profit from what it sends. */
  hideCostWhenLocked: z.boolean(),
  /** The first-launch wizard has been completed (or skipped). */
  setupDone: z.boolean(),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

export const DEFAULT_SETTINGS: PublicSettings = {
  storeName: '',
  ownerName: '',
  phone: '',
  address: '',
  logoFile: null,
  language: 'ar',
  theme: 'system',
  receiptSize: '80mm',
  receiptFooter: '',
  receiptPrinter: '',
  labelSize: '40x25',
  allowNegativeStock: false,
  autoPrintReceipt: true,
  debtDueDays: 30,
  repairTerms: '',
  askSeller: false,
  slipCopies: 2,
  warrantyNewDays: 365,
  warrantyUsedDays: 30,
  warrantyAccessoryDays: 0,
  hideCostWhenLocked: true,
  setupDone: false,
};

export const passwordSchema = z.string().min(4).max(100);
export const sectionListSchema = z.array(z.enum(SECTION_IDS));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const expenseInputSchema = z.object({
  buyer: z.string().trim().min(1).max(120),
  categoryId: z.string().min(1),
  date: isoDate,
  amount: z.number().int().positive(),
  note: z.string().max(400).default(''),
  receiptPath: z.string().nullable().default(null),
  /** Paid from the cash drawer: writes a cash movement OUT. */
  fromCash: z.boolean().default(true),
});
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

export const expenseFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: z.string().optional(),
  search: z.string().optional(),
});
export type ExpenseFilter = z.infer<typeof expenseFilterSchema>;

// ---- Stock ----
export const UNIT_STATUSES = ['IN_STOCK', 'SOLD', 'IN_REPAIR', 'RETURNED', 'WRITTEN_OFF'] as const;
export const CONDITIONS = ['NEW', 'USED', 'REFURBISHED'] as const;
export const ADJUST_REASONS = ['COUNT_CORRECTION', 'DAMAGED', 'LOST'] as const;
export const CATEGORY_KINDS = ['PHONE', 'ACCESSORY', 'PART'] as const;

const centimes = z.number().int().min(0).max(100_000_000_000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const idSchema = z.object({ id: z.string().min(1) });
export const nameInputSchema = z.object({ name: z.string().trim().min(1).max(80) });
export const categoryInputSchema = nameInputSchema.extend({ kind: z.enum(CATEGORY_KINDS) });

export const unitFilterSchema = z.object({
  status: z.enum(UNIT_STATUSES).optional(),
  brandId: z.string().optional(),
  condition: z.enum(CONDITIONS).optional(),
});
export type UnitFilter = z.infer<typeof unitFilterSchema>;

export const modelInputSchema = z.object({
  brandId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  storage: z.string().trim().max(30).default(''),
  color: z.string().trim().max(30).default(''),
});

const unitFields = {
  // The service checks length, digits, Luhn and duplicates, so the UI gets a specific message.
  imei1: z.string().trim().max(40),
  imei2: optionalText(40),
  condition: z.enum(CONDITIONS),
  batteryHealth: z.number().int().min(0).max(100).nullish().transform((v) => v ?? null),
  grade: optionalText(10),
  cost: centimes,
  salePrice: centimes.refine((v) => v > 0),
  notes: z.string().trim().max(500).default(''),
};
export const unitAddSchema = z
  .object({ ...unitFields, minPrice: centimes.default(0), productId: z.string().min(1).optional(), model: modelInputSchema.optional() })
  .refine((d) => !!d.productId !== !!d.model, { message: 'model_required' });
export type UnitAddInput = z.input<typeof unitAddSchema>;
// Cost is left out when the editor was not shown it (Finance locked): the stored cost then stays.
export const unitUpdateSchema = z.object({ id: z.string().min(1), ...unitFields, imei1: optionalText(40), cost: centimes.optional() });
export const unitPriceSchema = z.object({ id: z.string().min(1), salePrice: centimes.refine((v) => v > 0) });
export const unitWriteOffSchema = z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(200) });
export const imeiStatusSchema = z.object({ imei: z.string().trim().max(40), excludeUnitId: z.string().optional() });

export const itemFilterSchema = z.object({
  categoryId: z.string().optional(),
  lowStockOnly: z.boolean().optional(),
  repairPartsOnly: z.boolean().optional(),
});
export type ItemFilter = z.infer<typeof itemFilterSchema>;

export const itemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().min(1),
  brandId: z.string().nullish().transform((v) => v || null),
  barcode: optionalText(40),
  salePrice: centimes,
  minPrice: centimes.default(0),
  avgCost: centimes.default(0),
  lowStockThreshold: z.number().int().min(0).max(100000).default(0),
  defaultWarrantyDays: z.number().int().min(0).max(3650).default(0),
  isRepairPart: z.boolean().default(false),
});
export type ItemInput = z.input<typeof itemInputSchema>;
export const itemUpdateSchema = itemInputSchema.extend({ id: z.string().min(1), avgCost: centimes.optional() });
export const itemAdjustSchema = z.object({
  id: z.string().min(1),
  delta: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 1_000_000),
  reason: z.enum(ADJUST_REASONS),
});
export const searchSchema = z.object({ q: z.string().trim().min(2).max(60) });
export const lookupSchema = z.object({ code: z.string().trim().min(1).max(60) });

// ---- Purchases and suppliers ----
export const SUPPLIER_KINDS = ['COMPANY', 'INDIVIDUAL'] as const;
export const PAYMENT_METHODS = ['CASH', 'BANK', 'OTHER'] as const;
const isoDateTime = z.string().datetime();

export const supplierInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).default(''),
  address: z.string().trim().max(200).default(''),
  kind: z.enum(SUPPLIER_KINDS).default('COMPANY'),
  idDocumentNumber: optionalText(40),
  notes: z.string().trim().max(500).default(''),
});
export type SupplierInput = z.input<typeof supplierInputSchema>;
export const supplierUpdateSchema = supplierInputSchema.extend({ id: z.string().min(1) });

export const paymentInputSchema = z.object({
  supplierId: z.string().min(1),
  amount: centimes.refine((v) => v > 0),
  date: isoDateTime,
  method: z.enum(PAYMENT_METHODS).default('CASH'),
  note: z.string().trim().max(300).default(''),
});

const phoneLineFields = {
  imei1: unitFields.imei1,
  imei2: unitFields.imei2,
  condition: unitFields.condition,
  batteryHealth: unitFields.batteryHealth,
  grade: unitFields.grade,
  cost: centimes,
  salePrice: centimes.refine((v) => v > 0),
  minPrice: centimes.default(0),
  productId: z.string().min(1).optional(),
  model: modelInputSchema.optional(),
};
export const phoneLineSchema = z.object(phoneLineFields).refine((d) => !!d.productId !== !!d.model, { message: 'model_required' });
export const itemLineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(1_000_000),
  unitCost: centimes,
});

export const purchaseInputSchema = z.object({
  supplierId: z.string().min(1),
  date: isoDateTime,
  paid: centimes.default(0),
  note: z.string().trim().max(500).default(''),
  invoicePath: z.string().nullable().default(null),
  /** A file already stored by the PC (a photo a phone uploaded through /files). */
  invoiceFile: z.string().regex(/^[0-9a-f-]{36}\.(jpe?g|png|webp)$/).nullish().transform((v) => v ?? null),
  /** Sent by a phone: a repeated id returns the first purchase instead of creating another. */
  requestId: z.string().trim().min(8).max(64).nullish().transform((v) => v ?? null),
  itemLines: z.array(itemLineSchema).max(500).default([]),
  phoneLines: z.array(phoneLineSchema).max(500).default([]),
});
export type PurchaseInput = z.input<typeof purchaseInputSchema>;

export const purchaseFilterSchema = z.object({
  supplierId: z.string().optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
export type PurchaseFilter = z.infer<typeof purchaseFilterSchema>;

/** Buying one phone from a private seller: the seller becomes (or is found as) an INDIVIDUAL supplier. */
export const buyBackSchema = z.object({
  sellerName: z.string().trim().min(1).max(120),
  sellerPhone: z.string().trim().min(1).max(40),
  sellerIdNumber: z.string().trim().min(1).max(40),
  date: isoDateTime,
  line: phoneLineSchema,
});

// ---- Sales ----
export const SALE_METHODS = ['CASH', 'CCP', 'BARIDIMOB', 'OTHER'] as const;

export const saleLineSchema = z
  .object({
    unitId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    quantity: z.number().int().min(1).max(100_000).default(1),
    unitPrice: centimes,
    discount: centimes.default(0), // for the whole line
    warrantyDays: z.number().int().min(0).max(3650).default(0),
  })
  .refine((l) => !!l.unitId !== !!l.productId, { message: 'line_target' });

export const tradeInSchema = z
  .object({
    // A trade-in phone may come without a readable IMEI; one that is typed is checked like any other.
    imei1: optionalText(40),
    imei2: unitFields.imei2,
    condition: unitFields.condition,
    batteryHealth: unitFields.batteryHealth,
    grade: unitFields.grade,
    value: centimes.refine((v) => v > 0),
    productId: z.string().min(1).optional(),
    model: modelInputSchema.optional(),
  })
  .refine((d) => !!d.productId !== !!d.model, { message: 'model_required' });

export const saleInputSchema = z.object({
  customerId: z.string().nullish().transform((v) => v || null),
  employeeId: z.string().nullish().transform((v) => v || null),
  discount: centimes.default(0),
  paid: centimes,
  paymentMethod: z.enum(SALE_METHODS).default('CASH'),
  lines: z.array(saleLineSchema).min(1).max(200),
  tradeIn: tradeInSchema.nullish().transform((v) => v ?? null),
  /** Sent by a phone: a repeated id returns the first sale instead of selling again. */
  requestId: z.string().trim().min(8).max(64).nullish().transform((v) => v ?? null),
  /** Needed only when a line is priced below its minimum. */
  managerPassword: z.string().max(100).optional(),
});
export type SaleInput = z.input<typeof saleInputSchema>;

export const saleFilterSchema = z.object({
  customerId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  employeeId: z.string().optional(),
  unpaidOnly: z.boolean().optional(),
});
export type SaleFilter = z.infer<typeof saleFilterSchema>;

export const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).default(''),
  whatsapp: z.string().trim().max(40).default(''),
  address: z.string().trim().max(200).default(''),
  notes: z.string().trim().max(500).default(''),
});

// ---- Customers, payments, returns ----
export const customerUpdateSchema = customerInputSchema.extend({ id: z.string().min(1) });

export const customerPaymentSchema = z.object({
  customerId: z.string().min(1),
  amount: centimes.refine((v) => v > 0),
  date: z.string().datetime(),
  method: z.enum(SALE_METHODS).default('CASH'),
  note: z.string().trim().max(300).default(''),
});

export const customerFilterSchema = z.object({
  inDebt: z.boolean().optional(),
  overdue: z.boolean().optional(),
});

export const returnLineSchema = z.object({
  saleLineId: z.string().min(1),
  quantity: z.number().int().min(1).max(100_000),
  restock: z.boolean(),
});
export const returnPreviewSchema = z.object({ saleId: z.string().min(1), lines: z.array(returnLineSchema).min(1) });
export const returnInputSchema = z.object({
  saleId: z.string().min(1),
  reason: z.string().trim().min(1).max(300),
  lines: z.array(returnLineSchema).min(1),
  /** An exchange: the replacement sale, created in the same step and paid with the returned value first. */
  exchange: saleInputSchema.nullish().transform((v) => v ?? null),
});
export const saleFindSchema = z.object({ query: z.string().trim().min(1).max(40) });

// ---- Repairs ----
export const REPAIR_STATUSES = ['RECEIVED', 'DIAGNOSING', 'WAITING_PARTS', 'READY', 'DELIVERED', 'CANCELLED', 'UNREPAIRABLE'] as const;
export const OPEN_REPAIR_STATUSES = ['RECEIVED', 'DIAGNOSING', 'WAITING_PARTS', 'READY'] as const;
export const ARRIVAL_FLAGS = ['POWERS_ON', 'SCREEN_CRACKED', 'BACK_CRACKED', 'WATER_DAMAGE', 'MISSING_PARTS'] as const;
export const ACCESSORY_ITEMS = ['SIM', 'MEMORY_CARD', 'CASE', 'CHARGER'] as const;
/** Intake slips carry this as a QR code; scanning it anywhere opens the ticket. */
export const QR_TOKEN_PATTERN = /^PSM-[A-Za-z0-9_-]{12}$/;

export const MAX_REPAIR_PHOTOS = 6;
const STORED_FILE = /^[0-9a-f-]{36}\.(jpe?g|png|webp)$/;
const shortText = (max: number) => z.string().trim().max(max).default('');

export const repairInputSchema = z.object({
  customerId: z.string().min(1),
  brand: shortText(60),
  model: shortText(80),
  imei: optionalText(40),
  fault: z.string().trim().min(1).max(300),
  arrival: z.object({ flags: z.array(z.enum(ARRIVAL_FLAGS)).default([]), note: shortText(300) }).default({ flags: [], note: '' }),
  accessories: z.object({ items: z.array(z.enum(ACCESSORY_ITEMS)).default([]), note: shortText(200) }).default({ items: [], note: '' }),
  unlockNote: shortText(200),
  estimatedPrice: centimes.default(0),
  deposit: centimes.default(0),
  depositMethod: z.enum(SALE_METHODS).default('CASH'),
  employeeId: z.string().nullish().transform((v) => v || null),
  dueAt: z.string().datetime().nullish().transform((v) => v ?? null),
  /** Photos of the device already uploaded to the PC (names returned by POST /files). */
  photos: z.array(z.string().regex(STORED_FILE)).max(MAX_REPAIR_PHOTOS).default([]),
});
export type RepairInput = z.input<typeof repairInputSchema>;

export const repairUpdateSchema = z.object({
  id: z.string().min(1),
  fault: z.string().trim().min(1).max(300),
  unlockNote: shortText(200),
  estimatedPrice: centimes,
  employeeId: z.string().nullish().transform((v) => v || null),
  dueAt: z.string().datetime().nullish().transform((v) => v ?? null),
  notes: z.string().trim().max(2000).default(''),
});
export const repairFilterSchema = z.object({
  status: z.enum(REPAIR_STATUSES).optional(),
  employeeId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  overdue: z.boolean().optional(),
  /** The board: every open ticket plus those delivered since this moment. */
  boardSince: z.string().datetime().optional(),
});
export type RepairFilter = z.infer<typeof repairFilterSchema>;
export const repairStatusSchema = z.object({ id: z.string().min(1), status: z.enum(OPEN_REPAIR_STATUSES), note: shortText(300) });
export const repairPartSchema = z.object({ repairId: z.string().min(1), productId: z.string().min(1), quantity: z.number().int().min(1).max(10_000) });
export const repairDeliverSchema = z.object({
  id: z.string().min(1),
  finalPrice: centimes,
  paid: centimes.default(0),
  method: z.enum(SALE_METHODS).default('CASH'),
  warrantyDays: z.number().int().min(0).max(3650).default(0),
  note: shortText(300),
});
export const repairCancelSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['CANCELLED', 'UNREPAIRABLE']),
  /** A diagnosis fee, or 0. */
  fee: centimes.default(0),
  /** true: give the deposit back (less the fee). false: keep it, as the fee. */
  refundDeposit: z.boolean(),
  note: shortText(300),
});
export const repairPhotoSchema = z.object({ repairId: z.string().min(1), fileName: z.string().regex(STORED_FILE) });
export const repairTokenSchema = z.object({ token: z.string().regex(QR_TOKEN_PATTERN) });

// ---- Services and the cash drawer ----
export const MARGIN_TYPES = ['PERCENT', 'FIXED'] as const;
export const MANUAL_REASONS = ['OWNER_WITHDRAWAL', 'CHANGE_ADDED', 'BANK_DEPOSIT', 'OTHER'] as const;

export const serviceSellSchema = z.object({
  serviceId: z.string().min(1),
  amount: centimes.refine((v) => v > 0),
  /** Only for "other" services (flexy cost follows the margin rule). */
  cost: centimes.nullish().transform((v) => v ?? null),
  phoneNumber: optionalText(20),
  employeeId: z.string().nullish().transform((v) => v || null),
});
export const serviceCreateSchema = z.object({ name: z.string().trim().min(1).max(80), defaultPrice: centimes.default(0) });
export const serviceUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  marginType: z.enum(MARGIN_TYPES),
  marginValue: z.number().int().min(0).max(100_000_000),
  defaultPrice: centimes.default(0),
  active: z.boolean(),
});
export const serviceSalesFilterSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() });

export const cashOpenSchema = z.object({ openingFloat: centimes });
export const cashManualSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  amount: centimes.refine((v) => v > 0),
  reason: z.enum(MANUAL_REASONS),
  note: z.string().trim().max(200).default(''),
});
export const cashCloseSchema = z.object({ counted: centimes, note: z.string().trim().max(300).default('') });

// ---- Employees ----
export const EMPLOYEE_ROLES = ['SELLER', 'TECHNICIAN', 'CASHIER', 'OTHER'] as const;

export const employeeInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(EMPLOYEE_ROLES).default('SELLER'),
  phone: z.string().trim().max(40).default(''),
  monthlySalary: centimes.default(0),
  /** Hundredths of a percent: 1000 = 10%. Informative only. */
  commissionSalesBp: z.number().int().min(0).max(10_000).default(0),
  commissionRepairsBp: z.number().int().min(0).max(10_000).default(0),
});
export const employeeUpdateSchema = employeeInputSchema.extend({ id: z.string().min(1) });

export const salaryPaymentSchema = z.object({
  employeeId: z.string().min(1),
  amount: centimes.refine((v) => v > 0),
  /** Part of an outstanding advance taken out of this payment. */
  deduct: centimes.default(0),
  note: z.string().trim().max(200).default(''),
  method: z.enum(SALE_METHODS).default('CASH'),
  date: z.string().datetime(),
});
export const advanceSchema = z.object({
  employeeId: z.string().min(1),
  kind: z.enum(['GIVE', 'REPAY']),
  amount: centimes.refine((v) => v > 0),
  note: z.string().trim().max(200).default(''),
  method: z.enum(SALE_METHODS).default('CASH'),
  date: z.string().datetime(),
});
export const employeeActivitySchema = z.object({ id: z.string().min(1), from: z.string().datetime(), to: z.string().datetime() });

// ---- Analytics, reports, export ----
export const FINANCE_METRICS = ['salesRevenue', 'salesProfit', 'repairRevenue', 'repairProfit', 'serviceMargin', 'expenses', 'salaries', 'netProfit'] as const;
export const REPORT_KINDS = ['bestModels', 'bestAccessories', 'profitByBrand', 'profitByEmployee', 'slowStock', 'lowStock', 'debtsAgeing'] as const;

export const periodSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() });
export const seriesSchema = periodSchema.extend({ metric: z.enum(FINANCE_METRICS) });
export const reportSchema = periodSchema.extend({ kind: z.enum(REPORT_KINDS), slowDays: z.number().int().min(1).max(3650).default(60) });
export const exportSchema = z.object({
  title: z.string().trim().min(1).max(60),
  headers: z.array(z.string().max(80)).min(1).max(30),
  /** Plain values; money is sent as a number of DA. */
  rows: z.array(z.array(z.union([z.string().max(500), z.number(), z.null()]))).max(50_000),
  /** Indexes of the columns holding money, formatted with two decimals. */
  moneyColumns: z.array(z.number().int().min(0)).max(30).default([]),
});

export const importPathSchema = z.object({ path: z.string().min(1).max(1024) });

// ---- Phones on the local network ----
export const MOBILE_ROLES = ['OWNER', 'SELLER', 'TECHNICIAN', 'STOCK'] as const;
export type MobileRole = (typeof MOBILE_ROLES)[number];
export const MOBILE_DEFAULT_PORT = 4780;

export const mobileConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
});
/** Access from outside the shop: off, full, or view only. */
export const REMOTE_MODES = ['off', 'full', 'view'] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];
export const mobileRemoteConfigSchema = z.object({ mode: z.enum(REMOTE_MODES) });
export const mobileDeviceUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  role: z.enum(MOBILE_ROLES),
  employeeId: z.string().nullish().transform((v) => v || null),
});

// ---- Stock counts ----
export const COUNT_SCOPES = ['PHONES', 'ITEMS', 'CATEGORY'] as const;
export const countStartSchema = z
  .object({ scope: z.enum(COUNT_SCOPES), categoryId: z.string().min(1).optional() })
  .refine((d) => (d.scope === 'CATEGORY') === !!d.categoryId, { message: 'category_required' });
export const countScanUnitSchema = z.object({ countId: z.string().min(1), code: z.string().trim().min(1).max(40) });
export const countItemSchema = z.object({ countId: z.string().min(1), productId: z.string().min(1), quantity: z.number().int().min(0).max(1_000_000) });
export const countDecisionSchema = z.object({ countId: z.string().min(1), unitId: z.string().min(1), action: z.enum(['WRITE_OFF', 'KEEP']) });
