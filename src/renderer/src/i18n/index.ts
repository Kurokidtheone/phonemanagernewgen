import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar.json';
import en from './en.json';
import fr from './fr.json';

// Every visible string lives in these three files. Add a key to all three at once.
void i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar }, fr: { translation: fr }, en: { translation: en } },
  lng: 'ar',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
