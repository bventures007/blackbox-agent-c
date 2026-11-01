import en from './en.json';
import de from './de.json';

export type Locale = 'en' | 'de';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'de'];
export const DEFAULT_LOCALE: Locale = 'en';

/** i18next-compatible resource bundle: one `translation` namespace per locale. */
export const resources = {
  en: { translation: en },
  de: { translation: de },
} as const;

export type TranslationSchema = typeof en;

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'de';
}

/** BCP-47 tags used for Intl formatting; German defaults to the Germany region. */
export const INTL_TAGS: Record<Locale, string> = { en: 'en-GB', de: 'de-DE' };
