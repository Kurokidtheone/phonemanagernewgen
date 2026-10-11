// The sale receipt: store header, lines with IMEI and warranty end, totals and the footer from
// settings. One HTML body feeds the on-screen preview, the 80 mm / A5 print and the WhatsApp text.
import type { TFunction } from 'i18next';
import type { PublicSettings } from '@shared/schemas';
import { fileUrl, type ApiResult } from './api';
import { formatDate, formatDateTime } from './hooks';
import { escapeHtml, printDocument } from './print';

export type Sale = ApiResult<'sales.get'>;
type Money = (centimes: number) => string;

/** The logo as a data URI: the print window cannot reach the app's own file scheme. */
async function logoDataUri(name: string | null): Promise<string | null> {
  if (!name) return null;
  try {
    const blob = await (await fetch(fileUrl(name))).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function receiptBody(t: TFunction, lang: string, sale: Sale, settings: PublicSettings, money: Money): Promise<string> {
  const e = escapeHtml;
  const logo = await logoDataUri(settings.logoFile);
  const model = (l: Sale['lines'][number]): string => [l.name, l.storage, l.color].filter(Boolean).join(' ');
  const lines = sale.lines
    .map((l) => {
      const detail = [
        l.imei1 ? `<span dir="ltr">IMEI ${e(l.imei1)}</span>` : '',
        l.warrantyEnd ? e(t('sell.receipt.warrantyUntil', { date: formatDate(l.warrantyEnd, lang) })) : '',
        l.discount > 0 ? e(t('sell.receipt.lineDiscount', { amount: money(l.discount) })) : '',
      ].filter(Boolean);
      return `<tr><td>${e(model(l))}${l.quantity > 1 ? ` × ${l.quantity}` : ''}${detail.length ? `<br><span class="muted">${detail.join(' · ')}</span>` : ''}</td><td class="end">${e(money(l.lineTotal))}</td></tr>`;
    })
    .join('');
  const row = (label: string, value: string, cls = ''): string => `<tr class="${cls}"><td>${e(label)}</td><td class="end">${e(value)}</td></tr>`;
  const totals = [
    sale.discount > 0 || sale.tradeInValue > 0 ? row(t('sell.subtotal'), money(sale.subtotal)) : '',
    sale.discount > 0 ? row(t('sell.discount'), `-${money(sale.discount)}`) : '',
    sale.tradeInValue > 0 ? row(t('sell.tradeIn'), `-${money(sale.tradeInValue)}`) : '',
    row(t('sell.total'), money(sale.total), 'total'),
    row(t('sell.paid'), money(sale.paid)),
    sale.remaining > 0 ? row(t('sell.remaining'), money(sale.remaining), 'total') : '',
  ].join('');

  return `
    <div class="center">${logo ? `<img src="${logo}" style="max-height:18mm;max-width:60%">` : ''}
    <h1>${e(settings.storeName)}</h1>
    <div class="muted">${e([settings.phone, settings.address].filter(Boolean).join(' · '))}</div></div>
    <div class="rule"></div>
    <table>
      ${row(t('sell.receipt.number'), sale.receiptNumber)}
      ${row(t('sell.receipt.date'), formatDateTime(sale.date, lang))}
      ${sale.employeeName ? row(t('sell.seller'), sale.employeeName) : ''}
      ${sale.customerName ? row(t('sell.customer'), sale.customerName) : ''}
    </table>
    <div class="rule"></div>
    <table>${lines}</table>
    <div class="rule"></div>
    <table>${totals}</table>
    ${settings.receiptFooter ? `<div class="rule"></div><p class="center muted">${e(settings.receiptFooter).replace(/\n/g, '<br>')}</p>` : ''}`;
}

export async function printReceipt(t: TFunction, lang: string, sale: Sale, settings: PublicSettings, money: Money): Promise<boolean> {
  return printDocument(await receiptBody(t, lang, sale, settings, money), settings.receiptSize);
}

/** Algerian numbers are typed 05xx..., wa.me wants the international form without + or 0. */
export function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('0') ? `213${digits.slice(1)}` : digits;
}

export function whatsappUrl(t: TFunction, lang: string, sale: Sale, settings: PublicSettings, money: Money): string {
  const lines = sale.lines.map((l) => `• ${[l.name, l.storage, l.color].filter(Boolean).join(' ')}${l.quantity > 1 ? ` × ${l.quantity}` : ''} — ${money(l.lineTotal)}`);
  const text = [
    settings.storeName,
    `${t('sell.receipt.number')}: ${sale.receiptNumber} (${formatDate(sale.date, lang)})`,
    ...lines,
    `${t('sell.total')}: ${money(sale.total)}`,
    `${t('sell.paid')}: ${money(sale.paid)}`,
    ...(sale.remaining > 0 ? [`${t('sell.remaining')}: ${money(sale.remaining)}`] : []),
    ...(settings.receiptFooter ? ['', settings.receiptFooter] : []),
  ].join('\n');
  const number = whatsappNumber(sale.customerWhatsapp || sale.customerPhone || '');
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
