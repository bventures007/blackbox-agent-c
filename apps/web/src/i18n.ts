import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, INTL_TAGS, isLocale, resources, type Locale } from '@blackbox/i18n';

// Only the locale preference is kept in localStorage — never a key, session or business data.
const LOCALE_STORAGE_KEY = 'blackbox.locale';

export function readStoredLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode or blocked storage: the server-side workspace locale still applies after login.
  }
}

function browserLocale(): Locale {
  const lang = (navigator.language || '').toLowerCase();
  return lang.startsWith('de') ? 'de' : DEFAULT_LOCALE;
}

export const initialLocale: Locale = readStoredLocale() ?? browserLocale();

void i18next.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function applyLocale(locale: Locale): void {
  if (i18next.language !== locale) void i18next.changeLanguage(locale);
  document.documentElement.lang = locale;
  storeLocale(locale);
  document.title = i18next.t('meta.title');
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', i18next.t('meta.description'));
}

export function intlTag(locale: string): string {
  return INTL_TAGS[(isLocale(locale) ? locale : DEFAULT_LOCALE) as Locale];
}

export default i18next;
