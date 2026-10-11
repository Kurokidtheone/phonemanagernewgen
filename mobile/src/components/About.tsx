// The "made by" card: the developer's logo and a button that opens a WhatsApp chat with them.
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { APP } from '@shared/app.config';
import logo from '@/assets/next-level.png';
import { errorText } from '@/lib/client';
import { toast } from '@/lib/toast';
import { openWhatsapp } from '@/lib/whatsapp';

export function About() {
  const { t } = useTranslation();
  return (
    <button
      className="mx-4 my-4 flex w-[calc(100%-2rem)] items-center gap-4 rounded-3xl bg-[#05060f] p-4 text-start transition active:scale-[0.99] active:opacity-90"
      onClick={() => void openWhatsapp(APP.developer.phone, '').catch((err) => toast(errorText(t, err)))}
      aria-label={`${APP.developer.name} WhatsApp ${APP.developer.phone}`}
    >
      <img src={logo} alt="" className="h-20 w-20 shrink-0 rounded-2xl" />
      <span className="min-w-0 flex-1 text-[#e8e4d8]">
        <span className="block text-xs uppercase tracking-wide text-[#8f8c82]">{t('m.about.madeBy')}</span>
        <span className="block truncate text-lg font-semibold">{APP.developer.name}</span>
        <span className="mt-1 flex items-center gap-2 text-sm text-[#5eead4]">
          <MessageCircle className="h-4 w-4" />
          <span dir="ltr">{APP.developer.phone}</span>
        </span>
      </span>
    </button>
  );
}
