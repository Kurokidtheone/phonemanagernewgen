// Generated from core/src/api.rs by `cargo test -p psm-core` (test api::tests::typescript_is_current). Do not edit.
import type { z } from 'zod';
import type { SectionId } from './app.config';
import type * as s from './schemas';

export type Accessories = { items: Array<string>, note: string, };

export type ActivityRepair = { id: string, ticket: string, brand: string, model: string, closedAt: string, price: number, profit: number | null, };

export type ActivitySale = { id: string, receiptNumber: string, date: string, total: number, status: string, profit: number | null, };

export type ActivityTotals = { salesCount: number, salesTotal: number, repairsCount: number, repairsTotal: number, salesProfit: number | null, repairsProfit: number | null, commission: number | null, };

export type Added = { added: number, };

export type AdvanceResult = { id: string, advanceAfter: number, };

export type AdvanceRow = { id: string, date: string | null, type: 'SALARY' | 'ADVANCE' | 'ADVANCE_REPAYMENT', amount: number, note: string, method: string, };

export type ApkInfo = { versionName: string, versionCode: number, size: number, };

export type Applied = { label: string, amount: number, };

export type Arrival = { flags: Array<string>, note: string, };

export type AuthStatus = { hasPassword: boolean, unlocked: boolean, protectedSections: SectionId[], };

export type Brand = { id: string, name: string, createdAt: string, updatedAt: string, };

export type BuyBackResult = { id: string, supplierId: string, };

export type CancelResult = { fee: number, refund: number, remaining: number, };

export type CashMovement = { id: string, sessionId: string | null, type: string, direction: 'IN' | 'OUT', amount: number, refTable: string | null, refId: string | null, note: string, at: string, createdAt: string, updatedAt: string, 
/**
 * The phone whose cash this is, until the manager confirms receiving it.
 */
heldByDevice: string | null, };

export type CashSession = { id: string, openedAt: string, openingFloat: number, closedAt: string | null, countedAmount: number | null, expectedAmount: number | null, difference: number | null, note: string, createdAt: string, updatedAt: string, };

export type CashState = { open: boolean, sessionId: string | null, lastCounted: number, };

export type Category = { id: string, name: string, kind: 'PHONE' | 'ACCESSORY' | 'PART', createdAt: string, updatedAt: string, };

export type CloseResult = { id: string, expected: number, counted: number, difference: number, };

export type ConflictRow = { id: string, deviceId: string, deviceName: string | null, opId: string, reason: string, status: string, resolution: string | null, resolvedAt: string | null, createdAt: string, 
/**
 * What the phone tried to do.
 */
op: Record<string, unknown>, 
/**
 * What the PC has now for the unit or the IMEI in question.
 */
pcHas: Record<string, unknown>, };

export type CountResult = { id: string, scope: 'PHONES' | 'ITEMS' | 'CATEGORY', categoryId: string | null, status: 'OPEN' | 'CLOSED', applied: boolean, startedAt: string, closedAt: string | null, counted: number, itemsCounted: number, missing: Array<MissingUnit>, unexpected: Array<UnexpectedScan>, differences: Array<ItemDifference>, missingCost: number | null, differenceCost: number | null, };

export type CountStarted = { id: string, joined: boolean, };

export type CountSummary = { id: string, scope: 'PHONES' | 'ITEMS' | 'CATEGORY', categoryName: string | null, status: 'OPEN' | 'CLOSED', applied: boolean, startedAt: string, closedAt: string | null, startedBy: string | null, counted: number, missing: number, unexpected: number, differences: number, };

export type CountUnitView = { id: string, name: string, storage: string, color: string, imei: string | null, status: string, cost: number | null, salePrice: number, };

export type CurrentCash = { session: CashSession, expected: number, totalIn: number, totalOut: number, movements: Array<CashMovement>, };

export type Customer = { id: string, name: string, phone: string, whatsapp: string, address: string, notes: string, deletedAt: string | null, createdAt: string, updatedAt: string, };

export type CustomerDetail = { customer: Customer, stats: CustomerStats, sales: Array<SaleRow>, repairs: Array<CustomerRepair>, payments: Array<CustomerPaymentGroup>, phones: Array<CustomerPhone>, openItems: Array<OpenItem>, };

export type CustomerOverviewRow = { id: string, name: string, phone: string, whatsapp: string, totalBought: number, balance: number, lastVisit: string | null, oldestUnpaid: string | null, overdue: boolean, };

export type CustomerPaymentGroup = { id: string, date: string, amount: number, method: string, note: string, balanceBefore: number | null, balanceAfter: number | null, };

export type CustomerPhone = { unitId: string, imei1: string | null, name: string, storage: string, saleId: string, receipt: string, date: string, warrantyDays: number, warrantyEnd: string | null, warranty: 'NONE' | 'ACTIVE' | 'EXPIRED', };

export type CustomerRepair = { id: string, ticket: string, brand: string, model: string, fault: string, status: string, receivedAt: string, price: number, deposit: number, };

export type CustomerStats = { totalBought: number, totalPaid: number, balance: number, };

export type CustomerWithBalance = { id: string, name: string, phone: string, whatsapp: string, address: string, notes: string, deletedAt: string | null, createdAt: string, updatedAt: string, balance: number, };

export type DayValue = { day: string, value: number, };

export type DebtRow = { customerId: string, balance: number, };

export type DeductionRow = { id: string, date: string | null, amount: number, };

export type DeliverResult = { remaining: number, warrantyEnd: string | null, };

export type DetailRow = { id: string, kind: 'SALE' | 'RETURN' | 'REPAIR' | 'SERVICE' | 'EXPENSE' | 'SALARY' | 'DAY', 
/**
 * ISO instant, or a local day for DAY and EXPENSE rows.
 */
date: string, label: string, detail: string, value: number, link: string | null, parts?: { [key in string]: number }, };

export type Device = { id: string, name: string, role: 'OWNER' | 'SELLER' | 'TECHNICIAN' | 'STOCK' | null, employeeId: string | null, lastSeenAt: string | null, revokedAt: string | null, createdAt: string, 
/**
 * How the phone last reached the PC: the shop Wi-Fi or the mailbox (outside the shop).
 */
lastSeenVia: 'lan' | 'remote' | null, };

export type DeviceRow = { employeeName: string | null, id: string, name: string, role: 'OWNER' | 'SELLER' | 'TECHNICIAN' | 'STOCK' | null, employeeId: string | null, lastSeenAt: string | null, revokedAt: string | null, createdAt: string, 
/**
 * How the phone last reached the PC: the shop Wi-Fi or the mailbox (outside the shop).
 */
lastSeenVia: 'lan' | 'remote' | null, };

export type Duplicate = { id: string, model: string, status: string, };

export type Employee = { id: string, name: string, role: string, phone: string, monthlySalary: number, commissionSalesBp: number, commissionRepairsBp: number, deletedAt: string | null, createdAt: string, updatedAt: string, };

export type EmployeeActivity = { sales: Array<ActivitySale>, repairs: Array<ActivityRepair>, totals: ActivityTotals, rates: Rates, };

export type EmployeeDetail = { employee: Employee, stats: EmployeeStats, salaries: Array<SalaryRow>, advances: Array<AdvanceRow>, deductions: Array<DeductionRow>, };

export type EmployeeOverview = { id: string, name: string, role: string, phone: string, monthlySalary: number, commissionSalesBp: number, commissionRepairsBp: number, deletedAt: string | null, createdAt: string, updatedAt: string, advanceBalance: number, };

export type EmployeeStats = { advanceBalance: number, totalPaidThisYear: number, salariesThisYear: number, };

export type ExchangeRef = { id: string, receiptNumber: string, };

export type Expense = { id: string, buyer: string, categoryId: string, date: string, amount: number, note: string, receiptFile: string | null, createdAt: string, updatedAt: string, };

export type ExpenseCategory = { id: string, name: string, createdAt: string, updatedAt: string, };

export type ExpenseRow = { id: string, buyer: string, categoryId: string, categoryName: string, date: string, amount: number, note: string, receiptFile: string | null, };

export type HeldCash = { deviceId: string, deviceName: string | null, amount: number, count: number, };

export type Id = { id: string, };

export type ImeiStatus = { valid: boolean, duplicate: Duplicate | null, };

export type ImportPreview = { rows: Array<ImportRow>, valid: number, invalid: number, newCategories: Array<string>, };

export type ImportResult = { imported: number, skipped: number, categoriesCreated: number, };

export type ImportRow = { 
/**
 * The line in the file (the header is line 1).
 */
line: number, name: string, category: string, newCategory: boolean, barcode: string | null, quantity: number, cost: number, price: number, errors: ('name_required' | 'category_required' | 'price_invalid' | 'quantity_invalid' | 'cost_invalid' | 'barcode_invalid' | 'barcode_repeated' | 'barcode_exists')[], };

export type ItemDifference = { productId: string, name: string, system: number, counted: number, difference: number, differenceCost: number | null, };

export type ItemRow = { id: string, name: string, categoryId: string, categoryName: string, brandId: string | null, brandName: string | null, barcode: string | null, quantity: number, avgCost: number | null, salePrice: number, minPrice: number, lowStockThreshold: number, defaultWarrantyDays: number, isRepairPart: boolean, isLow: boolean, };

export type LicenseStatus = { 
/**
 * unconfigured = no public key embedded yet (development).
 */
state: 'licensed' | 'trial' | 'expired' | 'unconfigured', deviceId: string, customer?: string, edition?: string, issued?: string, daysLeft?: number, 
/**
 * Why the trial ended early, when it did.
 */
reason?: 'clock_changed', };

export type Lookup = { type: 'item' | 'unit', id: string, };

export type MethodTotal = { method: string, count: number, total: number, paid: number, };

export type MissingUnit = { id: string, name: string, storage: string, color: string, imei: string | null, status: string, cost: number | null, salePrice: number, decision: 'WRITE_OFF' | 'KEEP' | null, };

export type MobileOverview = { enabled: boolean, port: number, state: 'stopped' | 'running' | 'port_busy' | 'error', error: string | null, addresses: Array<string>, serverId: string, storeName: string, licensed: boolean, deviceLimit: number | null, deviceCount: number, apk: ApkInfo | null, apkUrls: Array<string>, remote: RemoteOverview, };

export type ModelRow = { id: string, brandId: string | null, brandName: string | null, name: string, model: string, storage: string, color: string, salePrice: number, minPrice: number, avgCost: number | null, };

export type MovementTotal = { type: string, direction: 'IN' | 'OUT', count: number, amount: number, };

export type OpResult = { opId: string, status: 'applied' | 'conflict' | 'rejected', 
/**
 * For conflict and rejected: why, as a code.
 */
reason: string | null, 
/**
 * For applied: the final ids and numbers.
 */
result: Record<string, unknown>, };

export type OpenItem = { kind: 'SALE' | 'REPAIR', id: string, 
/**
 * What orders the settlement: oldest first.
 */
date: string, label: string, remaining: number, customerId: string, };

export type Overview = { today: OverviewToday, attention: OverviewAttention, week: Array<DayValue>, };

export type OverviewAttention = { repairsReady: number, repairsOverdue: number, lowStock: number, debtsOverdue: number, debtsOverdueAmount: number, supplierBalances: number, supplierOwed: number, };

export type OverviewToday = { salesTotal: number, salesCount: number, profit: number | null, expectedCash: number | null, };

export type PairQr = { v: number, id: string, name: string, hosts: Array<string>, port: number, code: string, };

export type PairStart = { code: string, expiresAt: string, qr: PairQr, };

export type PairingStatus = { active: boolean, expiresAt: string | null, pairedDeviceId: string | null, };

export type PaymentReceipt = { customerId: string, customerName: string, customerPhone: string, date: string, method: string, note: string, balanceBefore: number | null, balanceAfter: number | null, amount: number, };

export type PaymentResult = { groupId: string, before: number, after: number, applied: Array<Applied>, credit: number, };

export type PreviewResult = { value: number, debtCancelled: number, refund: number, };

export type Printed = { printed: boolean, };

export type PublicSettings = { storeName: string, ownerName: string, phone: string, address: string, logoFile: string | null, language: 'ar' | 'fr' | 'en', theme: 'light' | 'dark' | 'system', receiptSize: '80mm' | 'A5', receiptFooter: string, receiptPrinter: string, labelSize: '40x25' | '50x30', allowNegativeStock: boolean, autoPrintReceipt: boolean, debtDueDays: number, repairTerms: string, askSeller: boolean, slipCopies: number, warrantyNewDays: number, warrantyUsedDays: number, warrantyAccessoryDays: number, hideCostWhenLocked: boolean, setupDone: boolean, };

export type PullResult = { cursor: number, 
/**
 * The phone's cursor is older than what the PC kept: drop the local copy and pull from 0.
 */
reset: boolean, 
/**
 * More changes wait: pull again with the new cursor.
 */
more: boolean, 
/**
 * Rows to insert or replace, by table.
 */
tables: Record<string, Array<Record<string, unknown>>>, 
/**
 * Ids to remove, by table.
 */
deletes: Record<string, string[]>, debts: Array<DebtRow>, limits: SyncLimits, };

export type PurchaseDetail = { id: string, date: string, supplierId: string, supplierName: string, supplierPhone: string, supplierKind: 'COMPANY' | 'INDIVIDUAL', supplierIdNumber: string | null, total: number, paid: number, note: string, invoiceFile: string | null, cancelledAt: string | null, remaining: number, lines: Array<PurchaseLineRow>, };

export type PurchaseLineRow = { id: string, productId: string, productName: string, storage: string, color: string, unitId: string | null, imei1: string | null, condition: 'NEW' | 'USED' | 'REFURBISHED' | null, quantity: number, unitCost: number, };

export type PurchaseRow = { id: string, date: string, supplierId: string, supplierName: string, supplierKind: 'COMPANY' | 'INDIVIDUAL', total: number, paid: number, cancelledAt: string | null, lineCount: number, remaining: number, };

export type PushResult = { results: Array<OpResult>, };

export type Rates = { sales: number, repairs: number, };

export type RecoveryCode = { recoveryCode: string, };

export type RemoteCode = { code: string, expiresAt: string, };

export type RemoteOverview = { mode: 'off' | 'full' | 'view', licensed: boolean, configured: boolean, state: 'off' | 'not_configured' | 'no_phone' | 'connecting' | 'connected' | 'blocked' | 'no_internet' | 'paused', 
/**
 * The network or server error behind no_internet, when known.
 */
reason: string | null, since: string, 
/**
 * Messages that did not open since the service started.
 */
dropped: number, };

export type RepairCreated = { id: string, ticketNumber: string, qrToken: string, };

export type RepairCustomer = { id: string, name: string, phone: string, whatsapp: string, };

export type RepairDetail = { id: string, ticketNumber: string, customerId: string, employeeId: string | null, brand: string, model: string, imei: string | null, fault: string, arrivalState: string, accessoriesLeft: string, unlockNote: string, estimatedPrice: number, finalPrice: number | null, deposit: number, status: 'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE', receivedAt: string, dueAt: string | null, deliveredAt: string | null, warrantyDays: number, qrToken: string, notes: string, closedAt: string | null, createdAt: string, updatedAt: string, arrival: Arrival, accessories: Accessories, customer: RepairCustomer, technicianName: string | null, parts: Array<RepairPartRow>, photos: Array<RepairPhoto>, payments: Array<RepairPaymentRow>, history: Array<RepairHistory>, paid: number, 
/**
 * What is still to pay: against the final price once closed, against the estimate while open.
 */
remaining: number, closed: boolean, overdue: boolean, warrantyEnd: string | null, profit: number | null, };

export type RepairHistory = { status: 'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE', at: string, note: string, };

export type RepairPartOption = { id: string, name: string, barcode: string | null, quantity: number, };

export type RepairPartRow = { id: string, productId: string, name: string, quantity: number, unitCost: number | null, };

export type RepairPaymentRow = { id: string, date: string, amount: number, method: string, note: string, };

export type RepairPhoto = { id: string, fileName: string, takenAt: string, };

export type RepairRow = { id: string, ticketNumber: string, status: 'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE', customerId: string, customerName: string, customerPhone: string, brand: string, model: string, imei: string | null, fault: string, receivedAt: string, dueAt: string | null, deliveredAt: string | null, estimatedPrice: number, finalPrice: number | null, employeeId: string | null, technicianName: string | null, paid: number, overdue: boolean, };

export type RepairTotals = { delivered: number, payments: number, };

export type Report = { columns: Array<string>, money: Array<string>, rows: (string | number | null)[][], };

export type ResolveResult = { resolution: string, sale: Record<string, unknown> | null, };

export type Restored = { restored: boolean, };

export type ReturnResult = { id: string, value: number, debtCancelled: number, refund: number, refundCash: number, status: 'RETURNED' | 'PARTIALLY_RETURNED', exchange: ExchangeRef | null, };

export type ReturnRow = { id: string, date: string, reason: string, returnedValue: number, refundAmount: number, debtCancelled: number, refundCash: number, exchangeSaleId: string | null, saleId: string, receiptNumber: string, customerName: string | null, exchangeReceipt: string | null, };

export type ReturnTotals = { count: number, value: number, cash: number, };

export type ReturnableLine = { id: string, name: string, storage: string, color: string, imei1: string | null, unitId: string | null, quantity: number, returnedQuantity: number, unitPrice: number, discount: number, };

export type SalaryResult = { id: string, net: number, advanceAfter: number, };

export type SalaryRow = { id: string, date: string | null, amount: number, note: string, method: string, deducted: number, };

export type SaleCreated = { id: string, receiptNumber: string, creditUsed: number, };

export type SaleDetail = { id: string, receiptNumber: string, date: string, subtotal: number, discount: number, total: number, paid: number, tradeInValue: number, paymentMethod: string, status: 'COMPLETED' | 'PARTIALLY_RETURNED' | 'RETURNED', customerId: string | null, customerName: string | null, customerPhone: string | null, customerWhatsapp: string | null, employeeName: string | null, remaining: number, returnedValue: number, returns: Array<SaleReturnSummary>, lines: Array<SaleLineDetail>, payments: Array<SalePaymentRow>, tradeIn: TradeInRow | null, profit: number | null, };

export type SaleLineDetail = { id: string, productId: string, name: string, storage: string, color: string, unitId: string | null, imei1: string | null, quantity: number, unitPrice: number, discount: number, warrantyDays: number, returnedQuantity: number, lineTotal: number, warrantyEnd: string | null, unitCost: number | null, profit: number | null, };

export type SalePaymentRow = { id: string, date: string, amount: number, method: string, note: string, };

export type SaleReturnSummary = { id: string, date: string, returnedValue: number, refundAmount: number, debtCancelled: number, reason: string, exchangeSaleId: string | null, };

export type SaleRow = { id: string, receiptNumber: string, date: string, total: number, paid: number, status: 'COMPLETED' | 'PARTIALLY_RETURNED' | 'RETURNED', customerId: string | null, customerName: string | null, employeeId: string | null, employeeName: string | null, remaining: number, itemsSummary: string | null, imeis: string | null, };

export type Saved = { saved: boolean, path: string | null, };

export type ScanOutcome = { status: 'counted' | 'already' | 'unexpected', reason: 'unknown' | 'not_in_stock' | 'out_of_scope' | null, unit: ScanUnitView | null, };

export type ScanUnitView = { id: string, name: string, storage: string, color: string, imei: string | null, status: string, };

export type SellResult = { id: string, margin: number, cost: number, };

export type SeriesResult = { days: Array<DayValue>, rows: Array<DetailRow>, };

export type Service = { id: string, name: string, kind: 'FLEXY' | 'OTHER', marginType: 'PERCENT' | 'FIXED', marginValue: number, defaultPrice: number, active: boolean, createdAt: string, updatedAt: string, };

export type ServiceSaleRow = { id: string, date: string, amount: number, cost: number, margin: number, phoneNumber: string | null, serviceName: string, serviceKind: 'FLEXY' | 'OTHER', employeeName: string | null, };

export type ServiceSales = { rows: Array<ServiceSaleRow>, totalAmount: number, totalMargin: number, };

export type ServiceTotals = { count: number, amount: number, margin: number, };

export type SessionRow = { id: string, openedAt: string, openingFloat: number, closedAt: string | null, countedAmount: number | null, expectedAmount: number | null, difference: number | null, note: string, createdAt: string, updatedAt: string, expected: number, };

export type StockSearch = { units: Array<UnitRow>, items: Array<ItemRow>, };

export type Suggestions = { brands: Array<string>, models: Array<string>, };

export type Summary = { salesRevenue: number, salesProfit: number, repairRevenue: number, repairProfit: number, serviceMargin: number, expenses: number, salaries: number, netProfit: number, customerDebts: number, supplierDebts: number, stockValueCost: number, stockValueSale: number, };

export type Supplier = { id: string, name: string, phone: string, address: string, kind: 'COMPANY' | 'INDIVIDUAL', idDocumentNumber: string | null, notes: string, deletedAt: string | null, createdAt: string, updatedAt: string, };

export type SupplierDetail = { supplier: Supplier, totals: Totals, purchases: Array<SupplierPurchase>, payments: Array<SupplierPayment>, };

export type SupplierPayment = { id: string, supplierId: string, amount: number, date: string, method: string, note: string, createdAt: string, updatedAt: string, };

export type SupplierPurchase = { id: string, date: string, total: number, paid: number, cancelledAt: string | null, lineCount: number, };

export type SupplierRow = { id: string, name: string, phone: string, address: string, kind: 'COMPANY' | 'INDIVIDUAL', idDocumentNumber: string | null, notes: string, deletedAt: string | null, createdAt: string, updatedAt: string, purchased: number, paid: number, balance: number, };

export type SyncLimits = { maxStaleDays: number, maxOutbox: number, serverTime: string, };

export type SystemInfo = { version: string, schemaVersion: number, dataDir: string, platform: string, };

export type TimelineEvent = { at: string, kind: string, reason: string, party: string | null, ref: string | null, };

export type Totals = { purchased: number, paid: number, balance: number, };

export type TradeInRow = { unitId: string, imei1: string | null, name: string, value: number, };

export type UnexpectedScan = { code: string | null, reason: 'unknown' | 'not_in_stock' | 'out_of_scope', unit: CountUnitView | null, };

export type UnitAdded = { id: string, productId: string, };

export type UnitDetail = { timeline: Array<TimelineEvent>, id: string, productId: string, brandId: string | null, brandName: string | null, name: string, model: string, storage: string, color: string, imei1: string | null, imei2: string | null, condition: 'NEW' | 'USED' | 'REFURBISHED', batteryHealth: number | null, grade: string | null, cost: number | null, salePrice: number, minPrice: number, defaultWarrantyDays: number, status: 'IN_STOCK' | 'SOLD' | 'IN_REPAIR' | 'RETURNED' | 'WRITTEN_OFF', notes: string, stockedAt: string, ageDays: number, };

export type UnitRow = { id: string, productId: string, brandId: string | null, brandName: string | null, name: string, model: string, storage: string, color: string, imei1: string | null, imei2: string | null, condition: 'NEW' | 'USED' | 'REFURBISHED', batteryHealth: number | null, grade: string | null, cost: number | null, salePrice: number, minPrice: number, defaultWarrantyDays: number, status: 'IN_STOCK' | 'SOLD' | 'IN_REPAIR' | 'RETURNED' | 'WRITTEN_OFF', notes: string, stockedAt: string, ageDays: number, };

export type ZReport = { session: CashSession, from: string, to: string, salesByMethod: Array<MethodTotal>, salesCount: number, salesTotal: number, returns: ReturnTotals, services: ServiceTotals, repairs: RepairTotals, debtPayments: number, expenses: number, movements: Array<MovementTotal>, openingFloat: number, totalIn: number, totalOut: number, expected: number, counted: number | null, difference: number | null, note: string, };

/** Every channel the window and the phones can call, with its input and what it returns. */
export type Api = {
  'auth.change': (input: { current: string; next: string }) => Promise<void>;
  'auth.lock': (input: void) => Promise<void>;
  'auth.newRecoveryCode': (input: { current: string }) => Promise<RecoveryCode>;
  'auth.remove': (input: { current: string }) => Promise<void>;
  'auth.reset': (input: { code: string; next: string }) => Promise<RecoveryCode>;
  'auth.setPassword': (input: { password: string }) => Promise<RecoveryCode>;
  'auth.setProtected': (input: { sections: SectionId[] }) => Promise<void>;
  'auth.status': (input: void) => Promise<AuthStatus>;
  'auth.unlock': (input: { password: string }) => Promise<void>;
  'backup.create': (input: void) => Promise<Saved>;
  'backup.restore': (input: void) => Promise<Restored>;
  'brands.addPopular': (input: void) => Promise<Added>;
  'brands.create': (input: z.input<typeof s.nameInputSchema>) => Promise<Brand>;
  'brands.delete': (input: { id: string }) => Promise<void>;
  'brands.list': (input: void) => Promise<Array<Brand>>;
  'brands.rename': (input: { id: string; name: string }) => Promise<void>;
  'cash.close': (input: z.input<typeof s.cashCloseSchema>) => Promise<CloseResult>;
  'cash.confirmPhoneCash': (input: { deviceId: string }) => Promise<number>;
  'cash.current': (input: void) => Promise<CurrentCash | null>;
  'cash.manual': (input: z.input<typeof s.cashManualSchema>) => Promise<void>;
  'cash.open': (input: z.input<typeof s.cashOpenSchema>) => Promise<Id>;
  'cash.phoneHeld': (input: void) => Promise<Array<HeldCash>>;
  'cash.report': (input: { id: string }) => Promise<ZReport>;
  'cash.sessions': (input: void) => Promise<Array<SessionRow>>;
  'cash.state': (input: void) => Promise<CashState>;
  'categories.create': (input: z.input<typeof s.categoryInputSchema>) => Promise<Category>;
  'categories.delete': (input: { id: string }) => Promise<void>;
  'categories.list': (input: void) => Promise<Array<Category>>;
  'categories.rename': (input: { id: string; name: string }) => Promise<void>;
  'customer.create': (input: z.input<typeof s.customerInputSchema>) => Promise<CustomerWithBalance>;
  'customer.delete': (input: { id: string }) => Promise<void>;
  'customer.get': (input: { id: string }) => Promise<CustomerDetail>;
  'customer.list': (input: z.input<typeof s.customerFilterSchema>) => Promise<Array<CustomerOverviewRow>>;
  'customer.payment': (input: { groupId: string }) => Promise<PaymentReceipt>;
  'customer.receivePayment': (input: z.input<typeof s.customerPaymentSchema>) => Promise<PaymentResult>;
  'customer.update': (input: z.input<typeof s.customerUpdateSchema>) => Promise<void>;
  'customers.create': (input: z.input<typeof s.customerInputSchema>) => Promise<CustomerWithBalance>;
  'customers.list': (input: void) => Promise<Array<CustomerWithBalance>>;
  'employee.activity': (input: z.input<typeof s.employeeActivitySchema>) => Promise<EmployeeActivity>;
  'employee.advance': (input: z.input<typeof s.advanceSchema>) => Promise<AdvanceResult>;
  'employee.create': (input: z.input<typeof s.employeeInputSchema>) => Promise<Employee>;
  'employee.delete': (input: { id: string }) => Promise<void>;
  'employee.get': (input: { id: string }) => Promise<EmployeeDetail>;
  'employee.list': (input: void) => Promise<Array<EmployeeOverview>>;
  'employee.paySalary': (input: z.input<typeof s.salaryPaymentSchema>) => Promise<SalaryResult>;
  'employee.update': (input: z.input<typeof s.employeeUpdateSchema>) => Promise<void>;
  'employees.list': (input: void) => Promise<Array<Employee>>;
  'expenses.categories': (input: void) => Promise<Array<ExpenseCategory>>;
  'expenses.create': (input: z.input<typeof s.expenseInputSchema>) => Promise<Expense>;
  'expenses.createCategory': (input: { name: string }) => Promise<ExpenseCategory>;
  'expenses.delete': (input: { id: string }) => Promise<void>;
  'expenses.deleteCategory': (input: { id: string }) => Promise<void>;
  'expenses.list': (input: z.input<typeof s.expenseFilterSchema>) => Promise<Array<ExpenseRow>>;
  'expenses.renameCategory': (input: { id: string; name: string }) => Promise<void>;
  'file.exportXlsx': (input: z.input<typeof s.exportSchema>) => Promise<Saved>;
  'finance.report': (input: z.input<typeof s.reportSchema>) => Promise<Report>;
  'finance.series': (input: z.input<typeof s.seriesSchema>) => Promise<SeriesResult>;
  'finance.summary': (input: z.input<typeof s.periodSchema>) => Promise<Summary>;
  'import.itemsCommit': (input: z.input<typeof s.importPathSchema>) => Promise<ImportResult>;
  'import.itemsPreview': (input: z.input<typeof s.importPathSchema>) => Promise<ImportPreview>;
  'import.template': (input: void) => Promise<Saved>;
  'items.adjust': (input: z.input<typeof s.itemAdjustSchema>) => Promise<void>;
  'items.create': (input: z.input<typeof s.itemInputSchema>) => Promise<Id>;
  'items.delete': (input: { id: string }) => Promise<void>;
  'items.generateBarcode': (input: void) => Promise<string>;
  'items.get': (input: { id: string }) => Promise<ItemRow>;
  'items.list': (input: z.input<typeof s.itemFilterSchema>) => Promise<Array<ItemRow>>;
  'items.update': (input: z.input<typeof s.itemUpdateSchema>) => Promise<void>;
  'license.activate': (input: { key: string }) => Promise<LicenseStatus>;
  'license.status': (input: void) => Promise<LicenseStatus>;
  'mobile.configure': (input: z.input<typeof s.mobileConfigSchema>) => Promise<MobileOverview>;
  'mobile.devices': (input: void) => Promise<Array<DeviceRow>>;
  'mobile.pairCancel': (input: void) => Promise<void>;
  'mobile.pairStart': (input: void) => Promise<PairStart>;
  'mobile.pairStatus': (input: void) => Promise<PairingStatus>;
  'mobile.remoteConfigure': (input: z.input<typeof s.mobileRemoteConfigSchema>) => Promise<MobileOverview>;
  'mobile.remotePairCancel': (input: void) => Promise<void>;
  'mobile.remotePairStart': (input: void) => Promise<RemoteCode>;
  'mobile.remotePairStatus': (input: void) => Promise<PairingStatus>;
  'mobile.revoke': (input: { id: string }) => Promise<void>;
  'mobile.status': (input: void) => Promise<MobileOverview>;
  'mobile.updateDevice': (input: z.input<typeof s.mobileDeviceUpdateSchema>) => Promise<Device>;
  'models.list': (input: void) => Promise<Array<ModelRow>>;
  'overview.get': (input: void) => Promise<Overview>;
  'print.html': (input: { html: string }) => Promise<boolean>;
  'print.printers': (input: void) => Promise<Array<string>>;
  'print.silent': (input: { html: string; requestId?: string }) => Promise<boolean>;
  'purchases.buyFromIndividual': (input: z.input<typeof s.buyBackSchema>) => Promise<BuyBackResult>;
  'purchases.cancel': (input: { id: string }) => Promise<void>;
  'purchases.create': (input: z.input<typeof s.purchaseInputSchema>) => Promise<Id>;
  'purchases.get': (input: { id: string }) => Promise<PurchaseDetail>;
  'purchases.list': (input: z.input<typeof s.purchaseFilterSchema>) => Promise<Array<PurchaseRow>>;
  'repairs.addPart': (input: z.input<typeof s.repairPartSchema>) => Promise<Id>;
  'repairs.addPhoto': (input: z.input<typeof s.repairPhotoSchema>) => Promise<void>;
  'repairs.byToken': (input: z.input<typeof s.repairTokenSchema>) => Promise<Id | null>;
  'repairs.cancel': (input: z.input<typeof s.repairCancelSchema>) => Promise<CancelResult>;
  'repairs.create': (input: z.input<typeof s.repairInputSchema>) => Promise<RepairCreated>;
  'repairs.deliver': (input: z.input<typeof s.repairDeliverSchema>) => Promise<DeliverResult>;
  'repairs.get': (input: { id: string }) => Promise<RepairDetail>;
  'repairs.list': (input: z.input<typeof s.repairFilterSchema>) => Promise<Array<RepairRow>>;
  'repairs.parts': (input: void) => Promise<Array<RepairPartOption>>;
  'repairs.printSlip': (input: { id: string }) => Promise<Printed>;
  'repairs.removePart': (input: { id: string }) => Promise<void>;
  'repairs.removePhoto': (input: { id: string }) => Promise<void>;
  'repairs.setStatus': (input: z.input<typeof s.repairStatusSchema>) => Promise<void>;
  'repairs.suggestions': (input: void) => Promise<Suggestions>;
  'repairs.update': (input: z.input<typeof s.repairUpdateSchema>) => Promise<void>;
  'returns.create': (input: z.input<typeof s.returnInputSchema>) => Promise<ReturnResult>;
  'returns.find': (input: z.input<typeof s.saleFindSchema>) => Promise<Array<SaleRow>>;
  'returns.lines': (input: { id: string }) => Promise<Array<ReturnableLine>>;
  'returns.list': (input: void) => Promise<Array<ReturnRow>>;
  'returns.preview': (input: z.input<typeof s.returnPreviewSchema>) => Promise<PreviewResult>;
  'sales.create': (input: z.input<typeof s.saleInputSchema>) => Promise<SaleCreated>;
  'sales.get': (input: { id: string }) => Promise<SaleDetail>;
  'sales.list': (input: z.input<typeof s.saleFilterSchema>) => Promise<Array<SaleRow>>;
  'sales.mine': (input: { from: string; to: string }) => Promise<Array<SaleRow>>;
  'sales.printReceipt': (input: { id: string }) => Promise<Printed>;
  'seed.load': (input: void) => Promise<void>;
  'services.active': (input: void) => Promise<Array<Service>>;
  'services.all': (input: void) => Promise<Array<Service>>;
  'services.create': (input: z.input<typeof s.serviceCreateSchema>) => Promise<Service>;
  'services.deleteSale': (input: { id: string }) => Promise<void>;
  'services.sales': (input: z.input<typeof s.serviceSalesFilterSchema>) => Promise<ServiceSales>;
  'services.sell': (input: z.input<typeof s.serviceSellSchema>) => Promise<SellResult>;
  'services.update': (input: z.input<typeof s.serviceUpdateSchema>) => Promise<void>;
  'settings.get': (input: void) => Promise<PublicSettings>;
  'settings.setLogo': (input: { path: string | null }) => Promise<PublicSettings>;
  'settings.update': (input: Partial<Omit<z.input<typeof s.publicSettingsSchema>, 'logoFile'>>) => Promise<PublicSettings>;
  'stock.lookup': (input: z.input<typeof s.lookupSchema>) => Promise<Lookup | null>;
  'stock.search': (input: z.input<typeof s.searchSchema>) => Promise<StockSearch>;
  'stockCount.apply': (input: { id: string }) => Promise<CountResult>;
  'stockCount.close': (input: { id: string }) => Promise<CountResult>;
  'stockCount.countItem': (input: z.input<typeof s.countItemSchema>) => Promise<void>;
  'stockCount.decide': (input: z.input<typeof s.countDecisionSchema>) => Promise<CountResult>;
  'stockCount.get': (input: { id: string }) => Promise<CountResult>;
  'stockCount.list': (input: void) => Promise<Array<CountSummary>>;
  'stockCount.scanUnit': (input: z.input<typeof s.countScanUnitSchema>) => Promise<ScanOutcome>;
  'stockCount.start': (input: z.input<typeof s.countStartSchema>) => Promise<CountStarted>;
  'suppliers.addPayment': (input: z.input<typeof s.paymentInputSchema>) => Promise<Id>;
  'suppliers.create': (input: z.input<typeof s.supplierInputSchema>) => Promise<Supplier>;
  'suppliers.delete': (input: { id: string }) => Promise<void>;
  'suppliers.get': (input: { id: string }) => Promise<SupplierDetail>;
  'suppliers.list': (input: void) => Promise<Array<SupplierRow>>;
  'suppliers.update': (input: z.input<typeof s.supplierUpdateSchema>) => Promise<void>;
  'sync.conflictCount': (input: void) => Promise<number>;
  'sync.conflicts': (input: void) => Promise<Array<ConflictRow>>;
  'sync.pull': (input: { cursor?: number }) => Promise<PullResult>;
  'sync.push': (input: { ops: Array<{ opId: string; type: string; madeAt: string; payload: unknown }> }) => Promise<PushResult>;
  'sync.resolve': (input: { id: string; action: 'discard' | 'apply'; unitId?: string }) => Promise<ResolveResult>;
  'system.info': (input: void) => Promise<SystemInfo>;
  'system.openDataFolder': (input: void) => Promise<void>;
  'units.add': (input: z.input<typeof s.unitAddSchema>) => Promise<UnitAdded>;
  'units.get': (input: { id: string }) => Promise<UnitDetail>;
  'units.imeiStatus': (input: z.input<typeof s.imeiStatusSchema>) => Promise<ImeiStatus>;
  'units.list': (input: z.input<typeof s.unitFilterSchema>) => Promise<Array<UnitRow>>;
  'units.setPrice': (input: z.input<typeof s.unitPriceSchema>) => Promise<void>;
  'units.update': (input: z.input<typeof s.unitUpdateSchema>) => Promise<void>;
  'units.writeOff': (input: z.input<typeof s.unitWriteOffSchema>) => Promise<void>;
};
