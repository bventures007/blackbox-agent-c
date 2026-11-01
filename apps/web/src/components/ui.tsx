import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { HttpError } from '../api/client';

/** Status badge: text + symbol, never color alone. */
export function StatusBadge({ kind, label, tone }: { kind?: string; label: string; tone?: 'ok' | 'working' | 'warn' | 'error' | 'neutral' | 'info' }) {
  const t = tone ?? toneFor(kind ?? '');
  const symbol = { ok: '●', working: '◐', warn: '▲', error: '✕', neutral: '○', info: '◆' }[t];
  return (
    <span className={`status-badge tone-${t}`} data-state={kind}>
      <span aria-hidden="true">{symbol}</span> {label}
    </span>
  );
}

export function toneFor(kind: string): 'ok' | 'working' | 'warn' | 'error' | 'neutral' | 'info' {
  switch (kind) {
    case 'healthy':
    case 'current':
    case 'ready':
    case 'complete':
    case 'completed':
    case 'active':
    case 'scheduled':
    case 'resolved':
    case 'syncing':
    case 'ok':
    case 'available':
      return 'ok';
    case 'working':
    case 'running':
    case 'initial_import':
    case 'in_progress':
    case 'queued':
    case 'implemented':
    case 'configured':
      return 'working';
    case 'degraded':
    case 'delayed':
    case 'partial':
    case 'paused':
    case 'overdue':
    case 'completed_with_gaps':
    case 'warning':
    case 'conflict':
    case 'stale':
    case 'WARN':
      return 'warn';
    case 'unavailable':
    case 'error':
    case 'failed':
    case 'blocked':
    case 'insufficient_data':
    case 'revoked':
    case 'expired':
    case 'critical':
    case 'disconnected':
    case 'ERROR':
    case 'redacted':
      return 'error';
    case 'unsupported':
    case 'planned':
    case 'not_configured':
    case 'unknown':
    case 'not_applicable':
    case 'canceled':
    case 'DEBUG':
      return 'neutral';
    default:
      return 'info';
  }
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  let text: string;
  if (error instanceof HttpError) {
    text = t(`errors.${error.code}`, { defaultValue: error.message });
    if (error.status === 429) text = t('errors.throttled');
  } else if (error instanceof Error) {
    text = error.message === 'Failed to fetch' ? t('errors.network') : error.message;
  } else text = String(error);
  return (
    <div className="error-note" role="alert">
      <Icon name="warning" />
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="btn small secondary" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <p className="loading" role="status" aria-live="polite">
      {label ?? t('common.loading')}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/** Modal dialog with focus trap, Escape to close and focus restore. */
export function Modal({ title, onClose, children, wide, labelledById }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; labelledById?: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const headingId = labelledById ?? `${id}-title`;
  useFocusTrap(ref, onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={headingId} ref={ref}>
        <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
        <h2 id={headingId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Right-side drawer used for evidence/entry/record details. */
export function Drawer({ title, eyebrow, onClose, children }: { title: ReactNode; eyebrow?: ReactNode; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, onClose);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} ref={ref}>
        <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" />
        </button>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2 id={`${id}-title`}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function useFocusTrap(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = () =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute('disabled'),
      );
    const first = focusable()[0];
    (first ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const items = focusable();
        if (!items.length) return;
        const firstItem = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus();
    };
  }, [ref, onClose]);
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard blocked; the text remains selectable
        }
      }}
    >
      <Icon name="copy" /> {done ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  );
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDone, 3500);
    return () => clearTimeout(timer);
  }, [message, onDone]);
  return (
    <div className={`toast${message ? ' show' : ''}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

export function DefinitionList({ rows }: { rows: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="detail-meta">
      {rows.map((r, i) => (
        <div key={i}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Field({ label, children, hint, htmlFor }: { label: ReactNode; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="field-group">
      <label className="form-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
