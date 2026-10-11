// Printed documents (receipts, cards, slips) are plain HTML strings: printed here with the system dialog, or sent
// to the core to be printed without one.
import { api } from './api';

const SIZES = {
  '80mm': '@page { size: 80mm auto; margin: 4mm; } body { width: 72mm; font-size: 12px; }',
  A5: '@page { size: A5; margin: 12mm; } body { font-size: 13px; }',
  '40x25': '@page { size: 40mm 25mm; margin: 0; } body { width: 40mm; font-size: 8px; }',
  '50x30': '@page { size: 50mm 30mm; margin: 0; } body { width: 50mm; font-size: 9px; }',
  A4: '@page { size: A4; margin: 14mm; } body { font-size: 13px; }',
} as const;

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** `body` is trusted HTML you built yourself: pass every user value through escapeHtml first. */
export function printDocument(body: string, size: keyof typeof SIZES = '80mm'): Promise<boolean> {
  return printHtml(documentHtml(body, size));
}

const settled = (img: HTMLImageElement): Promise<void> =>
  new Promise((done) => {
    img.addEventListener('load', () => done(), { once: true });
    img.addEventListener('error', () => done(), { once: true });
  });

/** Prints a complete HTML document through the system print dialog, from a hidden frame of this window. */
export function printHtml(html: string): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;inset-inline-start:-9999px';
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) return resolve(false);
      // Images (logo, QR code) must be there before the dialog shows the preview.
      const pending = Array.from(win.document.images).filter((img) => !img.complete);
      void Promise.all(pending.map(settled)).then(() => {
        win.focus();
        win.print(); // blocks until the dialog is closed
        setTimeout(() => frame.remove(), 1000);
        resolve(true);
      });
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** For what a phone asked to print: no dialog, on the printer chosen in Settings. `requestId` tells the PC the job's outcome. */
export function printSilently(body: string, size: keyof typeof SIZES, requestId: string): Promise<boolean> {
  return api('print.silent', { html: documentHtml(body, size), requestId });
}

function documentHtml(body: string, size: keyof typeof SIZES): string {
  const dir = document.documentElement.dir || 'rtl';
  const html = `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><style>
    ${SIZES[size]}
    body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #000; line-height: 1.45; }
    h1 { font-size: 1.25em; margin: 0 0 4px; } h2 { font-size: 1.05em; margin: 10px 0 4px; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 3px 0; text-align: start; vertical-align: top; }
    .end { text-align: end; } .center { text-align: center; } .muted { color: #555; }
    .rule { border-top: 1px dashed #000; margin: 8px 0; } .total { font-weight: 700; font-size: 1.15em; }
  </style></head><body>${body}</body></html>`;
  return html;
}
