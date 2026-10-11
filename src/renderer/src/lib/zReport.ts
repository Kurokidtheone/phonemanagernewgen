// The daily closing report (Z report), 80 mm: what happened between opening and closing the drawer.
import type { TFunction } from 'i18next';
import type { PublicSettings } from '@shared/schemas';
import type { ApiResult } from './api';
import { formatDateTime } from './hooks';
import { escapeHtml, printDocument } from './print';

export type ZReport = ApiResult<'cash.report'>;

export function printZReport(t: TFunction, lang: string, r: ZReport, settings: PublicSettings, money: (centimes: number) => string): Promise<boolean> {
  return printDocument(zReportBody(t, lang, r, settings, money), '80mm');
}

export function zReportBody(t: TFunction, lang: string, r: ZReport, settings: PublicSettings, money: (centimes: number) => string): string {
  const e = escapeHtml;
  const row = (label: string, value: string, cls = ''): string => `<tr class="${cls}"><td>${e(label)}</td><td class="end">${e(value)}</td></tr>`;
  const section = (title: string): string => `<h2>${e(title)}</h2>`;
  const movements = r.movements.map((m) => row(`${t(`cash.types.${m.type}`, { defaultValue: m.type })} (${m.count})`, `${m.direction === 'IN' ? '+' : '-'}${money(m.amount)}`)).join('');
  return `
    <h1 class="center">${e(settings.storeName)}</h1>
    <h2 class="center">${e(t('cash.z.title'))}</h2>
    <p class="center muted">${e(formatDateTime(r.from, lang))} → ${e(r.session.closedAt ? formatDateTime(r.to, lang) : t('cash.z.stillOpen'))}</p>
    <div class="rule"></div>
    ${section(t('cash.z.sales'))}
    <table>
      ${row(t('cash.z.count'), String(r.salesCount))}
      ${r.salesByMethod.map((m) => row(`${t(`sell.methods.${m.method}`, { defaultValue: m.method })} (${m.count})`, money(m.paid))).join('')}
      ${row(t('sell.total'), money(r.salesTotal), 'total')}
    </table>
    ${section(t('cash.z.returns'))}
    <table>${row(t('cash.z.count'), String(r.returns.count))}${row(t('sell.returns.value'), money(r.returns.value))}${row(t('cash.z.refundedCash'), money(r.returns.cash))}</table>
    ${section(t('cash.z.services'))}
    <table>${row(t('cash.z.count'), String(r.services.count))}${row(t('services.amount'), money(r.services.amount))}${row(t('services.margin'), money(r.services.margin))}</table>
    ${section(t('cash.z.repairs'))}
    <table>${row(t('cash.z.delivered'), String(r.repairs.delivered))}${row(t('cash.z.received'), money(r.repairs.payments))}</table>
    ${section(t('cash.z.debts'))}
    <table>${row(t('cash.z.received'), money(r.debtPayments))}</table>
    ${section(t('cash.z.expenses'))}
    <table>${row(t('sell.total'), money(r.expenses))}</table>
    <div class="rule"></div>
    ${section(t('cash.z.movements'))}
    <table>${movements}</table>
    <div class="rule"></div>
    <table>
      ${row(t('cash.openingFloat'), money(r.openingFloat))}
      ${row(t('cash.in'), `+${money(r.totalIn)}`)}
      ${row(t('cash.out'), `-${money(r.totalOut)}`)}
      ${row(t('cash.expected'), money(r.expected), 'total')}
      ${r.counted !== null ? row(t('cash.counted'), money(r.counted), 'total') : ''}
      ${r.difference !== null ? row(t('cash.difference'), money(r.difference), 'total') : ''}
    </table>
    ${r.note ? `<p class="muted">${e(r.note)}</p>` : ''}
    <p style="margin-top:12mm">${e(t('cash.z.signature'))} ________________</p>`;
}
