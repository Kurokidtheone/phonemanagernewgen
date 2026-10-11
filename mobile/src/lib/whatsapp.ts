// WhatsApp from the phone: the message and the customer's number go to the WhatsApp app through a wa.me link.
import { AppLauncher } from '@capacitor/app-launcher';

/** Algerian numbers are typed 05xx...; wa.me wants the international form without + or 0. */
export function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  return digits.startsWith('0') ? `213${digits.slice(1)}` : digits;
}

export const whatsappUrl = (phone: string, text: string): string => `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(text)}`;

export async function openWhatsapp(phone: string, text: string): Promise<void> {
  await AppLauncher.openUrl({ url: whatsappUrl(phone, text) });
}
