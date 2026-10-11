// The buy-back slip: what a shop hands to a private seller, with signature lines for both sides.
import type { TFunction } from 'i18next';
import type { PublicSettings } from '@shared/schemas';
import type { ApiResult } from './api';
import { formatDateTime } from './hooks';
import { escapeHtml, printDocument } from './print';

export function printBuyBackSlip(t: TFunction, lang: string, purchase: ApiResult<'purchases.get'>, settings: PublicSettings, money: (centimes: number) => string): Promise<boolean> {
  return printDocument(buyBackBody(t, lang, purchase, settings, money), settings.receiptSize);
}

export function buyBackBody(t: TFunction, lang: string, purchase: ApiResult<'purchases.get'>, settings: PublicSettings, money: (centimes: number) => string): string {
  const e = escapeHtml;
  const lines = purchase.lines
    .map((l) => `<tr><td>${e([l.productName, l.storage, l.color].filter(Boolean).join(' '))}<br><span class="muted" dir="ltr">IMEI ${e(l.imei1 ?? '—')}</span>${l.condition ? ` · ${e(t(`stock.condition.${l.condition}`))}` : ''}</td><td class="end">${e(money(l.unitCost * l.quantity))}</td></tr>`)
    .join('');
  return `
    <h1 class="center">${e(settings.storeName || '')}</h1>
    <p class="center muted">${e([settings.address, settings.phone].filter(Boolean).join(' · '))}</p>
    <h2 class="center">${e(t('stock.slip.title'))}</h2>
    <p class="center muted">${e(formatDateTime(purchase.date, lang))}</p>
    <div class="rule"></div>
    <table>
      <tr><td class="muted">${e(t('stock.slip.seller'))}</td><td class="end">${e(purchase.supplierName)}</td></tr>
      <tr><td class="muted">${e(t('stock.slip.phone'))}</td><td class="end" dir="ltr">${e(purchase.supplierPhone)}</td></tr>
      <tr><td class="muted">${e(t('stock.slip.idNumber'))}</td><td class="end" dir="ltr">${e(purchase.supplierIdNumber ?? '')}</td></tr>
    </table>
    <div class="rule"></div>
    <table>${lines}</table>
    <div class="rule"></div>
    <table><tr class="total"><td>${e(t('stock.slip.paid'))}</td><td class="end">${e(money(purchase.paid))}</td></tr></table>
    <p class="muted">${e(t('stock.slip.declaration'))}</p>
    <table style="margin-top:18mm">
      <tr><td class="center">${e(t('stock.slip.sellerSignature'))}<br><br><br>________________</td><td class="center">${e(t('stock.slip.buyerSignature'))}<br><br><br>________________</td></tr>
    </table>`;
}
