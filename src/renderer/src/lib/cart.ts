// The till's current cart and the sales parked with "Hold". Kept in localStorage so a restart
// does not lose a half-built sale. Nothing here is a business record: stock and money only
// change when the sale is paid (sales.create).
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CartLine {
  key: string;
  unitId: string | null;
  productId: string;
  name: string;
  imei: string | null;
  quantity: number;
  /** Stock on hand for items, null for phone units. */
  available: number | null;
  /** Centimes. */
  unitPrice: number;
  minPrice: number;
  /** Discount for the whole line, centimes. */
  discount: number;
  warrantyDays: number;
}

/** An exchange in progress: the return is only made when the replacement sale is paid. */
export interface ExchangeContext {
  saleId: string;
  receipt: string;
  customerId: string | null;
  reason: string;
  lines: { saleLineId: string; quantity: number; restock: boolean }[];
  /** What the return is worth to the customer (an estimate shown while building the new sale). */
  credit: number;
}

export interface HeldSale {
  id: string;
  at: string;
  lines: CartLine[];
  discount: number;
}

interface CartState {
  lines: CartLine[];
  discount: number;
  held: HeldSale[];
  exchange: ExchangeContext | null;
  setExchange: (exchange: ExchangeContext | null) => void;
  addLine: (line: Omit<CartLine, 'key'>) => 'added' | 'duplicate';
  patchLine: (key: string, patch: Partial<CartLine>) => void;
  removeLine: (key: string) => void;
  setDiscount: (centimes: number) => void;
  clear: () => void;
  /** Forgets the cart and the held sales: they point at records of a database that was replaced. */
  reset: () => void;
  hold: () => void;
  resume: (id: string) => void;
  dropHeld: (id: string) => void;
}

export const lineTotal = (l: CartLine): number => l.unitPrice * l.quantity - l.discount;
export const cartSubtotal = (lines: CartLine[]): number => lines.reduce((s, l) => s + lineTotal(l), 0);
export const belowMinimum = (l: CartLine): boolean => l.minPrice > 0 && lineTotal(l) < l.minPrice * l.quantity;

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],
      discount: 0,
      held: [],
      exchange: null,
      setExchange: (exchange) => set({ exchange }),
      addLine: (line) => {
        const { lines } = get();
        if (line.unitId) {
          // A phone unit is one physical phone: scanning it again does nothing.
          if (lines.some((l) => l.unitId === line.unitId)) return 'duplicate';
          set({ lines: [...lines, { ...line, key: line.unitId }] });
        } else {
          const same = lines.find((l) => l.productId === line.productId);
          if (same) set({ lines: lines.map((l) => (l === same ? { ...l, quantity: l.quantity + 1 } : l)) });
          else set({ lines: [...lines, { ...line, key: line.productId }] });
        }
        return 'added';
      },
      patchLine: (key, patch) => set({ lines: get().lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }),
      removeLine: (key) => set({ lines: get().lines.filter((l) => l.key !== key) }),
      setDiscount: (discount) => set({ discount }),
      clear: () => set({ lines: [], discount: 0, exchange: null }),
      reset: () => set({ lines: [], discount: 0, exchange: null, held: [] }),
      hold: () => {
        const { lines, discount, held } = get();
        if (lines.length === 0) return;
        set({ held: [...held, { id: crypto.randomUUID(), at: new Date().toISOString(), lines, discount }], lines: [], discount: 0 });
      },
      resume: (id) => {
        get().hold(); // park what is on the screen first, so nothing is lost
        const target = get().held.find((h) => h.id === id);
        if (target) set({ lines: target.lines, discount: target.discount, held: get().held.filter((h) => h.id !== id) });
      },
      dropHeld: (id) => set({ held: get().held.filter((h) => h.id !== id) }),
    }),
    { name: 'psm-cart', version: 1 },
  ),
);
