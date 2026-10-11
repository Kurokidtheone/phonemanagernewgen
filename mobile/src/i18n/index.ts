// The desktop translation files (errors, stock statuses, overview labels...) plus the phone-only strings under "m".
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import desktopAr from '@desktop-i18n/ar.json';
import desktopEn from '@desktop-i18n/en.json';
import desktopFr from '@desktop-i18n/fr.json';
import type { Language } from '@shared/app.config';
import ar from './ar.json';
import en from './en.json';
import fr from './fr.json';

void i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: { ...desktopAr, m: ar } },
    fr: { translation: { ...desktopFr, m: fr } },
    en: { translation: { ...desktopEn, m: en } },
  },
  lng: 'ar',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/** Language and writing direction together. */
export function applyLanguage(language: Language): void {
  void i18n.changeLanguage(language);
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
}

export default i18n;
