// Every printed document, in Arabic, French and English: no missing translation, the shop's own texts
// in place, amounts written the local way. (How the paper looks is checked by printing; this checks the words.)
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@shared/money';
import type { PublicSettings } from '@shared/schemas';
import { DEFAULT_SETTINGS } from '@shared/schemas';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';
import fr from '../i18n/fr.json';
import { paymentSlipBody } from './paymentSlip';
import { receiptBody } from './receipt';
import { deliveryReceiptBody, intakeSlipBody } from './repairSlips';
import { buyBackBody } from './slips';
import { zReportBody } from './zReport';

const RESOURCES = { ar, fr, en } as const;
type Lang = keyof typeof RESOURCES;
const LANGS: Lang[] = ['ar', 'fr', 'en'];

async function translator(lang: Lang) {
  const missing: string[] = [];
  const i = i18next.createInstance();
  await i.init({
    lng: lang,
    fallbackLng: false,
    resources: { [lang]: { translation: RESOURCES[lang] } },
    interpolation: { escapeValue: false },
    saveMissing: true,
    missingKeyHandler: (_l, _ns, key) => void missing.push(key),
    parseMissingKeyHandler: (key) => {
      missing.push(key);
      return key;
    },
  });
  return { t: i.getFixedT(lang), missing };
}

const settings = (lang: Lang): PublicSettings => ({
  ...DEFAULT_SETTINGS,
  language: lang,
  storeName: lang === 'ar' ? 'متجر النجاح للهواتف' : 'Téléphonie El Nadjah',
  ownerName: 'Karim',
  phone: '0550 12 34 56',
  address: lang === 'ar' ? 'شارع الاستقلال، الجزائر' : "Rue de l'Indépendance, Alger",
  receiptFooter: lang === 'ar' ? 'الضمان لا يشمل الكسر أو الماء.' : 'La garantie ne couvre pas la casse ni l’eau.',
  repairTerms: lang === 'ar' ? 'الأجهزة غير المسترجعة بعد 90 يوما لا نتحمل مسؤوليتها.' : 'Appareils non récupérés après 90 jours : non responsable.',
  slipCopies: 3,
});

const WHEN = '2026-10-06T10:30:00.000Z';
const sale = {
  receiptNumber: '2026-000042',
  date: WHEN,
  employeeName: 'Yacine',
  customerName: 'Walid',
  subtotal: 6_200_000,
  discount: 100_000,
  tradeInValue: 1_500_000,
  total: 4_600_000,
  paid: 2_000_000,
  remaining: 2_600_000,
  lines: [
    { name: 'Samsung Galaxy A15', storage: '128GB', color: 'Noir', imei1: '490154203237518', quantity: 1, lineTotal: 6_000_000, warrantyEnd: '2027-10-06T10:30:00.000Z', discount: 0 },
    { name: 'Chargeur 25W', storage: '', color: '', imei1: null, quantity: 2, lineTotal: 200_000, warrantyEnd: null, discount: 20_000 },
  ],
} as never;
const repair = {
  ticketNumber: 'R-2026-00007',
  receivedAt: WHEN,
  deliveredAt: WHEN,
  dueAt: '2026-10-09T10:00:00.000Z',
  customer: { id: 'c', name: 'Walid', phone: '0550 00 00 01', whatsapp: '' },
  brand: 'Samsung',
  model: 'A15',
  imei: '490154203237518',
  fault: 'Écran cassé',
  arrival: { flags: ['POWERS_ON', 'SCREEN_CRACKED'], note: 'rayures' },
  accessories: { items: ['SIM', 'CASE'], note: '' },
  unlockNote: '1234',
  estimatedPrice: 800_000,
  finalPrice: 800_000,
  paid: 200_000,
  remaining: 600_000,
  warrantyEnd: '2026-11-05T10:00:00.000Z',
  qrToken: 'PSM-abcdefghijkl',
} as never;
const purchase = {
  date: WHEN,
  supplierName: 'Karim Benali',
  supplierPhone: '0555 98 76 54',
  supplierIdNumber: '104512367',
  paid: 1_500_000,
  lines: [{ productName: 'Samsung Galaxy A10', storage: '32GB', color: '', imei1: '356938035643809', condition: 'USED', unitCost: 1_500_000, quantity: 1 }],
} as never;
const payment = { customerName: 'Walid', date: WHEN, method: 'CASH', balanceBefore: 3_000_000, amount: 2_500_000, balanceAfter: 500_000, note: '' } as never;
const z = {
  session: { closedAt: WHEN },
  from: WHEN,
  to: WHEN,
  salesByMethod: [
    { method: 'CASH', count: 2, total: 3_500_000, paid: 3_200_000 },
    { method: 'BARIDIMOB', count: 1, total: 1_000_000, paid: 1_000_000 },
  ],
  salesCount: 3,
  salesTotal: 4_500_000,
  returns: { count: 1, value: 100_000, cash: 100_000 },
  services: { count: 2, amount: 300_000, margin: 9_000 },
  repairs: { delivered: 1, payments: 800_000 },
  debtPayments: 250_000,
  expenses: 200_000,
  movements: [
    { type: 'SALE', direction: 'IN', count: 2, amount: 3_200_000 },
    { type: 'EXPENSE', direction: 'OUT', count: 1, amount: 200_000 },
    { type: 'MANUAL_OUT', direction: 'OUT', count: 1, amount: 100_000 },
    { type: 'EMPLOYEE_ADVANCE', direction: 'OUT', count: 1, amount: 50_000 },
  ],
  openingFloat: 1_000_000,
  totalIn: 4_000_000,
  totalOut: 350_000,
  expected: 4_650_000,
  counted: 4_640_000,
  difference: -10_000,
  note: '',
} as never;

describe.each(LANGS)('printed documents in %s', (lang) => {
  const documents = async () => {
    const { t, missing } = await translator(lang);
    const money = (n: number) => formatMoney(n, lang);
    const s = settings(lang);
    return {
      missing,
      docs: {
        receipt: await receiptBody(t, lang, sale, s, money),
        intake: intakeSlipBody(t, lang, repair, s, money, 'data:image/png;base64,AA=='),
        delivery: deliveryReceiptBody(t, lang, repair, s, money),
        buyBack: buyBackBody(t, lang, purchase, s, money),
        paymentSlip: paymentSlipBody(t, lang, payment, s, money),
        zReport: zReportBody(t, lang, z, s, money),
      },
    };
  };

  it('has no missing translation in any document', async () => {
    const { missing } = await documents();
    expect([...new Set(missing)]).toEqual([]);
  });

  it('prints the shop identity, its footer and terms where they belong, with amounts in the local currency', async () => {
    const { docs } = await documents();
    const s = settings(lang);
    const symbol = lang === 'ar' ? 'دج' : 'DA';
    for (const [name, html] of Object.entries(docs)) {
      expect(html, name).toContain(s.storeName);
      expect(html, name).not.toMatch(/undefined|NaN|\[object/);
      if (name !== 'zReport') expect(html, name).toContain(symbol);
    }
    expect(docs.receipt).toContain(s.receiptFooter);
    expect(docs.receipt).toContain('2026-000042');
    expect(docs.receipt).toContain('490154203237518'); // IMEI on the receipt
    expect(docs.receipt).toContain('46.000'); // total 46,000 DA, written 46.000
    expect(docs.intake).toContain(s.repairTerms);
    expect(docs.intake).toContain('data:image/png;base64'); // the QR code
    expect(docs.intake.match(/page-break-after:always/g)).toHaveLength(2); // three copies
    expect(docs.delivery).toContain(s.receiptFooter);
    expect(docs.buyBack).toContain('104512367');
    expect(docs.paymentSlip).toContain('5.000'); // balance after
  });

  it('is written in the language of the app', async () => {
    const { docs } = await documents();
    const text = Object.values(docs).join(' ');
    if (lang === 'ar') {
      expect(text).toMatch(/[؀-ۿ]{3,}/);
      expect(docs.receipt).toContain('الضمان حتى'); // warranty line
      expect(docs.zReport).toContain('تقرير الإغلاق اليومي');
    }
    if (lang === 'fr') {
      expect(docs.receipt).toContain('garantie jusqu');
      expect(docs.zReport).toContain('Rapport de clôture');
    }
    if (lang === 'en') {
      expect(docs.receipt).toContain('warranty until');
      expect(docs.zReport).toContain('Daily closing report');
    }
  });
});
