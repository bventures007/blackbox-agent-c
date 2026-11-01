import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { intlTag } from './i18n';

/** Locale-aware Intl formatting. Business values arrive from the API; nothing is calculated here. */
export function useFormat() {
  const { i18n, t } = useTranslation();
  const tag = intlTag(i18n.language);
  return useMemo(() => {
    const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' });
    const dateTimeSeconds = new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
    const date = new Intl.DateTimeFormat(tag, { dateStyle: 'medium' });
    const time = new Intl.DateTimeFormat(tag, { timeStyle: 'medium' });
    const number = new Intl.NumberFormat(tag);
    const utc = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
    const safe = (value: string | null | undefined, fmt: Intl.DateTimeFormat): string => {
      if (!value) return t('common.unknown');
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : fmt.format(d);
    };
    return {
      tag,
      dateTime: (v: string | null | undefined) => safe(v, dateTime),
      dateTimeSeconds: (v: string | null | undefined) => safe(v, dateTimeSeconds),
      date: (v: string | null | undefined) => safe(v, date),
      time: (v: string | null | undefined) => safe(v, time),
      utc: (v: string | null | undefined) => (v ? `${safe(v, utc)} UTC` : t('common.unknown')),
      inZone: (v: string | null | undefined, timeZone: string) => {
        if (!v) return t('common.unknown');
        try {
          return new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(new Date(v));
        } catch {
          return safe(v, dateTime);
        }
      },
      number: (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? t('common.unknown') : number.format(Number(v))),
      money: (minor: number | string | null | undefined, currency: string | undefined) => {
        if (minor === null || minor === undefined || minor === '') return t('common.unknown');
        const amount = Number(minor) / 100;
        try {
          return new Intl.NumberFormat(tag, { style: 'currency', currency: currency ?? 'EUR' }).format(amount);
        } catch {
          return `${number.format(amount)} ${currency ?? ''}`.trim();
        }
      },
      quantity: (v: number | string | null | undefined, unit?: string) => {
        if (v === null || v === undefined || v === '') return t('common.unknown');
        const n = Number(v);
        const formatted = Number.isNaN(n) ? String(v) : number.format(n);
        return unit ? `${formatted} ${t(`units.${unit}`, { defaultValue: unit })}` : formatted;
      },
      bytes: (v: number | null | undefined) => {
        if (v === null || v === undefined) return t('common.unknown');
        if (v < 1024) return `${number.format(v)} B`;
        if (v < 1024 ** 2) return `${number.format(Math.round(v / 1024))} KiB`;
        if (v < 1024 ** 3) return `${number.format(Math.round((v / 1024 ** 2) * 10) / 10)} MiB`;
        return `${number.format(Math.round((v / 1024 ** 3) * 10) / 10)} GiB`;
      },
      relative: (v: string | null | undefined) => {
        if (!v) return t('common.unknown');
        const ms = Date.now() - new Date(v).getTime();
        if (Number.isNaN(ms)) return v;
        const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
        const abs = Math.abs(ms);
        if (abs < 60_000) return rtf.format(-Math.round(ms / 1000), 'second');
        if (abs < 3_600_000) return rtf.format(-Math.round(ms / 60_000), 'minute');
        if (abs < 86_400_000) return rtf.format(-Math.round(ms / 3_600_000), 'hour');
        return rtf.format(-Math.round(ms / 86_400_000), 'day');
      },
      duration: (seconds: number | null | undefined) => {
        if (seconds === null || seconds === undefined) return t('common.unknown');
        if (seconds < 60) return t('common.durationSeconds', { count: Math.round(seconds) });
        if (seconds < 3600) return t('common.durationMinutes', { count: Math.round(seconds / 60) });
        if (seconds < 86400) return t('common.durationHours', { count: Math.round(seconds / 3600) });
        return t('common.durationDays', { count: Math.round(seconds / 86400) });
      },
    };
  }, [tag, t]);
}

export function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalDateTimeInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
