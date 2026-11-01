import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '../auth/SessionContext';
import { BrandMark, Icon } from './Icon';
import { Toast } from './ui';
import { diagnostics } from '../api/endpoints';
import type { HealthState } from '../api/types';
import { useAsync } from '../hooks';

export const LANDING_URL: string = (import.meta.env.VITE_LANDING_URL as string | undefined) ?? 'http://127.0.0.1:19181/';

const NAV: Array<{ to: string; icon: string; key: string; end?: boolean }> = [
  { to: '/app', icon: 'wave', key: 'recorder', end: true },
  { to: '/app/sources', icon: 'plug', key: 'sources' },
  { to: '/app/questions', icon: 'spark', key: 'questions' },
  { to: '/app/journal', icon: 'list', key: 'journal' },
  { to: '/app/agents', icon: 'code', key: 'agents' },
  { to: '/app/system', icon: 'pulse', key: 'system' },
  { to: '/app/settings', icon: 'settings', key: 'settings' },
];

type ToastApi = (message: string) => void;
let toastFn: ToastApi = () => undefined;
export const toast: ToastApi = (m) => toastFn(m);

export function AppShell() {
  const { t, i18n } = useTranslation();
  const { workspace, session, logout, setLocale } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  toastFn = setToastMessage;

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Lightweight runtime status for the top bar (shared health service, 5 s refresh only while the shell is open).
  const health = useAsync(() => diagnostics.health(), [], 5000);
  const overall: HealthState | 'disconnected' | 'stale' = health.error
    ? 'disconnected'
    : health.data
      ? (() => {
          const newest = Math.max(...health.data.cards.map((c) => new Date(c.observed_at).getTime()));
          if (Date.now() - newest > 30_000) return 'stale';
          if (health.data.cards.some((c) => c.state === 'unavailable')) return 'unavailable';
          if (health.data.cards.some((c) => c.state === 'degraded')) return 'degraded';
          if (health.data.cards.some((c) => c.state === 'working' || c.state === 'unknown')) return 'working';
          return 'healthy';
        })()
      : 'unknown';

  const current = NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
  const workspaceName = workspace?.display_name ?? session?.workspace.display_name ?? '';
  const initials = workspaceName
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const closeToast = useCallback(() => setToastMessage(null), []);
  const reviewCount = workspace?.unresolved_review_count ?? 0;

  return (
    <div className="app-layout">
      <a className="skip-link" href="#app-content">
        {t('common.skipToContent')}
      </a>
      <div className={`mobile-sidebar-overlay${menuOpen ? ' open' : ''}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className={`sidebar${menuOpen ? ' mobile-open' : ''}`} id="app-sidebar" aria-label={t('nav.sidebarLabel')}>
        <div className="brand">
          <BrandMark />
          blackbox<span className="brand-dot">.</span>
        </div>
        <div className="workspace-switch" aria-label={t('nav.workspace')}>
          <span className="workspace-avatar" aria-hidden="true">
            {initials || 'W'}
          </span>
          <div>
            {workspaceName}
            <small>{t('nav.workspaceKind')}</small>
          </div>
        </div>
        <div className="sidebar-label">{t('nav.sectionLabel')}</div>
        <nav className="side-nav" aria-label={t('nav.mainLabel')}>
          {NAV.map((item) => (
            <NavLink key={item.key} to={item.to} end={item.end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <Icon name={item.icon} />
              {t(`nav.${item.key}`)}
              {item.key === 'recorder' && <span className="nav-counter">5</span>}
              {item.key === 'sources' && reviewCount > 0 && (
                <span className="nav-counter" aria-label={t('review.countLabel', { count: reviewCount })}>
                  {reviewCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="side-divider" />
        <button type="button" className="nav-item" onClick={() => navigate('/app/questions')}>
          <Icon name="play" />
          {t('nav.askQuestion')}
        </button>
        <div className="sidebar-note">
          <div className="eyebrow">
            <i className="dot pulse" />
            {t('nav.noteTitle')}
          </div>
          <p>{t('nav.noteBody')}</p>
        </div>
        <div className="sidebar-bottom">
          <a href={LANDING_URL}>
            <Icon name="exit" /> {t('nav.toLanding')}
          </a>
          <button type="button" onClick={() => void logout()} aria-label={t('nav.logout')} title={t('nav.logout')}>
            <Icon name="lock" />
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="breadcrumb">
            <button
              type="button"
              className="icon-btn mobile-menu-btn"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={menuOpen ? t('nav.closeMenu') : t('nav.openMenu')}
              aria-expanded={menuOpen}
              aria-controls="app-sidebar"
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
            <span>{workspaceName}</span>
            <span aria-hidden="true">/</span>
            <strong>{current ? t(`nav.${current.key}`) : ''}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-badge">{t('nav.localPilotBadge')}</span>
            <NavLink to="/app/system" className={`live-label tone-${overall}`} title={t(`health.overall.${overall}`)}>
              <i className="dot" aria-hidden="true" />
              {t(`health.overall.${overall}`)}
            </NavLink>
            <label className="locale-switch">
              <span className="sr-only">{t('common.language')}</span>
              <select value={i18n.language.startsWith('de') ? 'de' : 'en'} onChange={(e) => void setLocale(e.target.value as 'en' | 'de')} aria-label={t('common.language')}>
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
            <span className="user-avatar" aria-label={t('nav.owner')} title={t('nav.owner')}>
              {initials || 'O'}
            </span>
          </div>
        </header>
        <main className="app-content" id="app-content" ref={mainRef} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <Toast message={toastMessage} onDone={closeToast} />
    </div>
  );
}

export function PageHeading({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}
