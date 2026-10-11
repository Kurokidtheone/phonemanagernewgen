// Receipts, repair slips and the closing report as a picture, handed to the Android share menu. WhatsApp to the
// customer's number is the first action. Nothing here decides money: it only lays out what the core already computed.
import type { TFunction } from 'i18next';
import type { Api } from '@shared/api';
import { printImage } from './printer';
import { shareBase64 } from './standalone';

type Awaited2<T> = T extends Promise<infer U> ? U : T;
type Sale = Awaited2<ReturnType<Api['sales.get']>>;
type Repair = Awaited2<ReturnType<Api['repairs.get']>>;
type Report = Awaited2<ReturnType<Api['cash.report']>>;
type Settings = Awaited2<ReturnType<Api['settings.get']>>;

export interface DocLine {
  text: string;
  /** Right-hand text on the same line (an amount). */
  right?: string;
  bold?: boolean;
  big?: boolean;
  center?: boolean;
  /** A thin rule instead of text. */
  rule?: boolean;
}

const WIDTH = 576; // an 80 mm receipt at 203 dpi, also a comfortable phone-sized picture

/** Draws the lines on a canvas and returns the PNG as base64. */
export function renderLines(lines: DocLine[], lang: string): string {
  const rtl = lang === 'ar';
  const pad = 24;
  const measure = document.createElement('canvas').getContext('2d')!;
  const rows = lines.map((l) => ({ ...l, h: l.rule ? 18 : l.big ? 44 : 34 }));
  const height = pad * 2 + rows.reduce((s, r) => s + r.h, 0);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#111';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  let y = pad;
  for (const r of rows) {
    if (r.rule) {
      ctx.fillRect(pad, y + 8, WIDTH - pad * 2, 1);
    } else {
      const font = `${r.bold || r.big ? '700' : '400'} ${r.big ? 30 : 22}px "Noto Sans Arabic", Roboto, system-ui, sans-serif`;
      ctx.font = font;
      measure.font = font;
      ctx.textBaseline = 'middle';
      const mid = y + r.h / 2;
      if (r.center) {
        ctx.textAlign = 'center';
        ctx.fillText(r.text, WIDTH / 2, mid, WIDTH - pad * 2);
      } else {
        ctx.textAlign = rtl ? 'right' : 'left';
        const startX = rtl ? WIDTH - pad : pad;
        const rightWidth = r.right ? measure.measureText(r.right).width + 16 : 0;
        ctx.fillText(r.text, startX, mid, WIDTH - pad * 2 - rightWidth);
        if (r.right) {
          ctx.textAlign = rtl ? 'left' : 'right';
          ctx.fillText(r.right, rtl ? pad : WIDTH - pad, mid);
        }
      }
    }
    y += r.h;
  }
  return canvas.toDataURL('image/png').split(',')[1];
}

const stamp = (lang: string, iso: string): string => new Date(iso).toLocaleString(lang === 'ar' ? 'ar-DZ-u-nu-latn' : lang, { dateStyle: 'short', timeStyle: 'short' });

const header = (s: Settings): DocLine[] => [
  { text: s.storeName, big: true, center: true },
  ...(s.address ? [{ text: s.address, center: true }] : []),
  ...(s.phone ? [{ text: s.phone, center: true }] : []),
  { text: '', rule: true },
];

export function saleLines(t: TFunction, lang: string, sale: Sale, s: Settings, money: (c: number) => string): DocLine[] {
  const waiting = (sale as { waiting?: boolean }).waiting;
  return [
    ...header(s),
    { text: `${t('sell.receipt.number')}: ${sale.receiptNumber}`, bold: true },
    { text: stamp(lang, sale.date) },
    ...(sale.customerName ? [{ text: `${t('sell.customer')}: ${sale.customerName}` }] : []),
    { text: '', rule: true },
    ...sale.lines.flatMap((l): DocLine[] => [
      { text: `${[l.name, l.storage, l.color].filter(Boolean).join(' ')}${l.quantity > 1 ? ` × ${l.quantity}` : ''}`, right: money(l.lineTotal) },
      ...(l.imei1 ? [{ text: `IMEI ${l.imei1}` }] : []),
    ]),
    { text: '', rule: true },
    { text: t('sell.total'), right: money(sale.total), bold: true },
    { text: t('sell.paid'), right: money(sale.paid) },
    ...(sale.remaining > 0 ? [{ text: t('sell.remaining'), right: money(sale.remaining), bold: true }] : []),
    ...(waiting ? [{ text: t('m.sync.finalNumber'), center: true }] : []),
    ...(s.receiptFooter ? [{ text: '', rule: true }, { text: s.receiptFooter, center: true }] : []),
  ];
}

export function repairLines(t: TFunction, lang: string, r: Repair, s: Settings, money: (c: number) => string): DocLine[] {
  return [
    ...header(s),
    { text: `${t('m.alone.ticket')}: ${r.ticketNumber}`, bold: true },
    { text: stamp(lang, r.receivedAt) },
    { text: `${r.customer.name}${r.customer.phone ? ` · ${r.customer.phone}` : ''}` },
    { text: '', rule: true },
    { text: `${r.brand} ${r.model}`.trim(), bold: true },
    ...(r.imei ? [{ text: `IMEI ${r.imei}` }] : []),
    { text: r.fault },
    { text: '', rule: true },
    { text: t('m.alone.estimate'), right: money(r.estimatedPrice) },
    ...(r.deposit > 0 ? [{ text: t('m.alone.deposit'), right: money(r.deposit) }] : []),
    ...(s.repairTerms ? [{ text: '', rule: true }, { text: s.repairTerms }] : []),
  ];
}

export function reportLines(t: TFunction, lang: string, r: Report, money: (c: number) => string): DocLine[] {
  return [
    { text: t('cash.z.title'), big: true, center: true },
    { text: `${stamp(lang, r.from)} → ${stamp(lang, r.to)}`, center: true },
    { text: '', rule: true },
    { text: t('cash.openingFloat'), right: money(r.openingFloat) },
    { text: t('sell.total'), right: money(r.salesTotal) },
    { text: t('cash.in'), right: money(r.totalIn) },
    { text: t('cash.out'), right: money(r.totalOut) },
    { text: '', rule: true },
    { text: t('cash.expected'), right: money(r.expected), bold: true },
    { text: t('cash.counted'), right: money(r.counted ?? 0), bold: true },
    { text: t('cash.difference'), right: money(r.difference ?? 0), bold: true },
  ];
}

const send = (lines: DocLine[], lang: string, name: string, title: string, whatsapp?: string): Promise<void> => shareBase64({ base64: renderLines(lines, lang), name, mime: 'image/png', title, whatsapp });

/** The receipt as a picture: WhatsApp to the customer when a number is given, else the share menu. */
export const shareSale = (t: TFunction, lang: string, sale: Sale, s: Settings, money: (c: number) => string, whatsapp?: string): Promise<void> =>
  send(saleLines(t, lang, sale, s, money), lang, `receipt-${sale.receiptNumber}.png`, t('sell.receiptTitle', { number: sale.receiptNumber }), whatsapp);

export const shareRepairSlip = (t: TFunction, lang: string, r: Repair, s: Settings, money: (c: number) => string, whatsapp?: string): Promise<void> =>
  send(repairLines(t, lang, r, s, money), lang, `repair-${r.ticketNumber}.png`, r.ticketNumber, whatsapp);

export const shareReport = (t: TFunction, lang: string, r: Report, money: (c: number) => string): Promise<void> => send(reportLines(t, lang, r, money), lang, `closing-${r.to.slice(0, 10)}.png`, t('cash.z.title'));

/** What a connected phone knows of the shop (the PC's settings are not offered to phones): just its name. */
export const minimalSettings = (storeName: string): Settings => ({ storeName, address: '', phone: '', receiptFooter: '', repairTerms: '' }) as Settings;

/** The same three documents on the phone's own Bluetooth printer. */
export const printSale = (t: TFunction, lang: string, sale: Sale, s: Settings, money: (c: number) => string): Promise<void> => printImage(renderLines(saleLines(t, lang, sale, s, money), lang));
export const printRepairSlip = (t: TFunction, lang: string, r: Repair, s: Settings, money: (c: number) => string): Promise<void> => printImage(renderLines(repairLines(t, lang, r, s, money), lang));
export const printReport = (t: TFunction, lang: string, r: Report, money: (c: number) => string): Promise<void> => printImage(renderLines(reportLines(t, lang, r, money), lang));
