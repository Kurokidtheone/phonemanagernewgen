// Shelf and phone labels: name, price and a barcode, printed on a label roll (40 x 25 or 50 x 30 mm).
// The barcode is drawn by JsBarcode (bundled with the app, no network). Phone units use the IMEI.
import JsBarcode from 'jsbarcode';
import { isValidEan13 } from '@shared/barcode';
import { escapeHtml, printDocument } from './print';

export type LabelSize = '40x25' | '50x30';

export interface LabelSource {
  name: string;
  /** Centimes. */
  price: number;
  /** Item barcode or unit IMEI. */
  code: string;
}

function barcodeSvg(code: string): string {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  JsBarcode(svg, code, {
    format: isValidEan13(code) ? 'EAN13' : 'CODE128',
    width: 1,
    height: 40,
    marginLeft: 8,
    marginRight: 8,
    marginTop: 0,
    marginBottom: 0,
    displayValue: true,
    fontSize: 12,
    textMargin: 1,
    background: '#ffffff',
  });
  // Let the printer scale the bars to the label width; the viewBox keeps their proportions.
  svg.setAttribute('viewBox', `0 0 ${parseFloat(svg.getAttribute('width') ?? '0')} ${parseFloat(svg.getAttribute('height') ?? '0')}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  return svg.outerHTML;
}

const CSS = `<style>
  .label { box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;
    page-break-after: always; break-after: page; padding: 1mm 1.5mm; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .l40x25 { width: 40mm; height: 25mm; } .l50x30 { width: 50mm; height: 30mm; padding: 1.5mm 2mm; }
  .label .n { font-weight: 600; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .label .p { font-weight: 800; font-size: 1.35em; line-height: 1.1; }
  .label svg { width: 100%; display: block; }
  .l40x25 svg { height: 11.5mm; } .l50x30 svg { height: 15mm; }
</style>`;

export function labelsHtml(labels: LabelSource[], size: LabelSize, copies: number, formatPrice: (centimes: number) => string): string {
  const one = (l: LabelSource): string =>
    `<div class="label l${size}"><div class="n">${escapeHtml(l.name)}</div><div class="p">${escapeHtml(formatPrice(l.price))}</div>${barcodeSvg(l.code)}</div>`;
  return CSS + labels.flatMap((l) => Array.from({ length: copies }, () => one(l))).join('');
}

export function printLabels(labels: LabelSource[], size: LabelSize, copies: number, formatPrice: (centimes: number) => string): Promise<boolean> {
  return printDocument(labelsHtml(labels, size, copies, formatPrice), size);
}
