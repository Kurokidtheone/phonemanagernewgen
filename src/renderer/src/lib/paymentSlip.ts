// The payment receipt: what a customer paid, and their balance before and after.
import type { TFunction } from 'i18next';
import type { PublicSettings } from '@shared/schemas';
import type { ApiResult } from './api';
import { formatDateTime } from './hooks';
import { escapeHtml, printDocument } from './print';

export type CustomerPayment = ApiResult<'customer.payment'>;

export function printPaymentSlip(t: TFunction, lang: string, p: CustomerPayment, settings: PublicSettings, money: (centimes: number) => string): Promise<boolean> {
  return printDocument(paymentSlipBody(t, lang, p, settings, money), settings.receiptSize);
}

export function paymentSlipBody(t: TFunction, lang: string, p: CustomerPayment, settings: PublicSettings, money: (centimes: number) => string): string {
  const e = escapeHtml;
  const row = (label: string, value: string, cls = ''): string => `<tr class="${cls}"><td>${e(label)}</td><td class="end">${e(value)}</td></tr>`;
  return `
    <h1 class="center">${e(settings.storeName)}</h1>
    <p class="center muted">${e([settings.phone, settings.address].filter(Boolean).join(' · '))}</p>
    <h2 class="center">${e(t('customers.slip.title'))}</h2>
    <div class="rule"></div>
    <table>
      ${row(t('sell.customer'), p.customerName)}
      ${row(t('sell.receipt.date'), formatDateTime(p.date, lang))}
      ${row(t('sell.method'), t(`sell.methods.${p.method}`, { defaultValue: p.method }))}
    </table>
    <div class="rule"></div>
    <table>
      ${p.balanceBefore !== null ? row(t('customers.slip.before'), money(p.balanceBefore)) : ''}
      ${row(t('customers.slip.paid'), money(p.amount), 'total')}
      ${p.balanceAfter !== null ? row(t('customers.slip.after'), money(p.balanceAfter), 'total') : ''}
    </table>
    ${p.note ? `<p class="muted">${e(p.note)}</p>` : ''}
    ${settings.receiptFooter ? `<div class="rule"></div><p class="center muted">${e(settings.receiptFooter)}</p>` : ''}`;
}
