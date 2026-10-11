// Repair paperwork: the intake slip (80 mm, printed twice: customer copy and shop copy, with a QR
// code of the ticket's token) and the delivery receipt.
import type { TFunction } from 'i18next';
import QRCode from 'qrcode';
import type { PublicSettings } from '@shared/schemas';
import type { ApiResult } from './api';
import { formatDate, formatDateTime } from './hooks';
import { escapeHtml, printDocument } from './print';

export type Repair = ApiResult<'repairs.get'>;
type Money = (centimes: number) => string;

const e = escapeHtml;
const row = (label: string, value: string, cls = ''): string => `<tr class="${cls}"><td class="muted">${e(label)}</td><td class="end">${value}</td></tr>`;
const header = (settings: PublicSettings): string =>
  `<h1 class="center">${e(settings.storeName)}</h1><p class="center muted">${e([settings.phone, settings.address].filter(Boolean).join(' · '))}</p>`;
const device = (r: Repair): string => [r.brand, r.model].filter(Boolean).join(' ') || '—';

export async function printIntakeSlip(t: TFunction, lang: string, r: Repair, settings: PublicSettings, money: Money): Promise<boolean> {
  const qr = await QRCode.toDataURL(r.qrToken, { margin: 1, width: 240 });
  return printDocument(intakeSlipBody(t, lang, r, settings, money, qr), '80mm');
}

/** The slip's HTML (80 mm). `qr` is the QR code of the ticket token as an image URL. */
export function intakeSlipBody(t: TFunction, lang: string, r: Repair, settings: PublicSettings, money: Money, qr: string): string {
  const flags = r.arrival.flags.map((f) => t(`repairs.arrival.${f}`));
  const accessories = [...r.accessories.items.map((a) => t(`repairs.accessory.${a}`)), r.accessories.note].filter(Boolean);
  const copy = (label: string, shop: boolean, last = false): string => `
    <div${last ? '' : ' style="page-break-after:always"'}>
      ${header(settings)}
      <h2 class="center">${e(t('repairs.slip.title'))} — ${e(label)}</h2>
      <p class="center total" dir="ltr">${e(r.ticketNumber)}</p>
      <p class="center muted">${e(formatDateTime(r.receivedAt, lang))}</p>
      <div class="rule"></div>
      <table>
        ${row(t('sell.customer'), `${e(r.customer.name)}<br><span dir="ltr">${e(r.customer.phone)}</span>`)}
        ${row(t('customers.device'), e(device(r)))}
        ${r.imei ? row('IMEI', `<span dir="ltr">${e(r.imei)}</span>`) : ''}
        ${row(t('customers.fault'), e(r.fault))}
        ${flags.length || r.arrival.note ? row(t('repairs.slip.arrival'), e([...flags, r.arrival.note].filter(Boolean).join(', '))) : ''}
        ${accessories.length ? row(t('repairs.slip.accessories'), e(accessories.join(', '))) : ''}
        ${shop && r.unlockNote ? row(t('repairs.form.unlockNote'), e(r.unlockNote)) : ''}
      </table>
      <div class="rule"></div>
      <table>
        ${row(t('repairs.form.estimate'), e(money(r.estimatedPrice)))}
        ${row(t('repairs.form.deposit'), e(money(r.paid)))}
        ${r.dueAt ? row(t('repairs.form.dueDate'), e(formatDate(r.dueAt, lang))) : ''}
      </table>
      <p class="center"><img src="${qr}" style="width:30mm;height:30mm"></p>
      ${settings.repairTerms ? `<p class="muted center">${e(settings.repairTerms)}</p>` : ''}
      ${shop ? `<p style="margin-top:10mm">${e(t('repairs.slip.customerSignature'))} ________________</p>` : ''}
    </div>`;
  // 1 copy: the customer's. 2: plus the shop's. 3: plus one to keep with the device.
  const copies = [copy(t('repairs.slip.customerCopy'), false, settings.slipCopies <= 1)];
  if (settings.slipCopies >= 2) copies.push(copy(t('repairs.slip.shopCopy'), true, settings.slipCopies < 3));
  if (settings.slipCopies >= 3) copies.push(copy(t('repairs.slip.deviceCopy'), true, true));
  return copies.join('');
}

export function printDeliveryReceipt(t: TFunction, lang: string, r: Repair, settings: PublicSettings, money: Money): Promise<boolean> {
  return printDocument(deliveryReceiptBody(t, lang, r, settings, money), settings.receiptSize);
}

export function deliveryReceiptBody(t: TFunction, lang: string, r: Repair, settings: PublicSettings, money: Money): string {
  return `
    ${header(settings)}
    <h2 class="center">${e(t('repairs.delivery.title'))}</h2>
    <p class="center muted">${e(formatDateTime(r.deliveredAt ?? r.receivedAt, lang))}</p>
    <div class="rule"></div>
    <table>
      ${row(t('repairs.slip.title'), `<span dir="ltr">${e(r.ticketNumber)}</span>`)}
      ${row(t('sell.customer'), e(r.customer.name))}
      ${row(t('customers.device'), e(device(r)))}
      ${row(t('customers.fault'), e(r.fault))}
    </table>
    <div class="rule"></div>
    <table>
      ${row(t('repairs.delivery.finalPrice'), e(money(r.finalPrice ?? 0)), 'total')}
      ${row(t('sell.paid'), e(money(r.paid)))}
      ${r.remaining > 0 ? row(t('sell.remaining'), e(money(r.remaining)), 'total') : ''}
      ${r.warrantyEnd ? row(t('sell.warranty'), e(t('sell.receipt.warrantyUntil', { date: formatDate(r.warrantyEnd, lang) }))) : ''}
    </table>
    ${settings.receiptFooter ? `<div class="rule"></div><p class="center muted">${e(settings.receiptFooter)}</p>` : ''}`;
}

/** wa.me link: a polite "your device is ready" message with the amount still due. */
export function notifyUrl(t: TFunction, r: Repair, settings: PublicSettings, money: Money, number: string): string {
  const text = t('repairs.notify.message', { name: r.customer.name, device: device(r), ticket: r.ticketNumber, store: settings.storeName, amount: money(Math.max(0, r.remaining)) });
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
