import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '../auth/SessionContext';
import { HttpError } from '../api/client';
import { BrandMark, Icon } from '../components/Icon';
import { LANDING_URL } from '../components/AppShell';

export function LoginView() {
  const { t, i18n } = useTranslation();
  const { status, login, setLocale } = useSession();
  const location = useLocation();
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    document.title = `${t('login.title')} — ${t('meta.title')}`;
  }, [t, i18n.language]);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from.startsWith('/app') ? from : '/app'} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!key.trim()) {
      setError(t('login.errors.empty'));
      return;
    }
    setBusy(true);
    try {
      await login(key.trim(), remember);
      setKey('');
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429) setError(t('login.errors.throttled'));
        else if (err.status === 401) setError(t('login.errors.invalid'));
        else if (err.status === 403) setError(t('login.errors.origin'));
        else setError(t('errors.generic', { code: err.code }));
      } else setError(t('errors.network'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-topbar">
        <div className="brand">
          <BrandMark />
          blackbox<span className="brand-dot">.</span>
        </div>
        <label className="locale-switch">
          <span className="sr-only">{t('common.language')}</span>
          <select value={i18n.language.startsWith('de') ? 'de' : 'en'} onChange={(e) => void setLocale(e.target.value as 'en' | 'de')} aria-label={t('common.language')}>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
      </div>
      <main className="login-card" id="app-content">
        <span className="eyebrow">
          <i className="dot" />
          {t('login.eyebrow')}
        </span>
        <h1>{t('login.title')}</h1>
        <p className="login-intro">{t('login.intro')}</p>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <label className="form-label" htmlFor="access-key">
            {t('login.keyLabel')}
          </label>
          <div className="key-input-row">
            <input
              id="access-key"
              className="field"
              type={showKey ? 'text' : 'password'}
              autoComplete="current-password"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t('login.keyPlaceholder')}
              aria-describedby="key-help"
              aria-invalid={error ? true : undefined}
            />
            <button type="button" className="btn small secondary" onClick={() => setShowKey((s) => !s)} aria-pressed={showKey}>
              {showKey ? t('login.hideKey') : t('login.showKey')}
            </button>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>
              {t('login.remember')}
              <small>{t('login.rememberHint')}</small>
            </span>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary full" disabled={busy}>
            {busy ? t('common.working') : t('login.submit')} <Icon name="arrow" />
          </button>
        </form>
        <div className="demo-callout" id="key-help">
          <strong>{t('login.ownerWarningTitle')}</strong>
          <p>{t('login.ownerWarningBody')}</p>
        </div>
        <details className="login-help">
          <summary>{t('login.helpSummary')}</summary>
          <ul>
            <li>{t('login.helpWhere')}</li>
            <li>
              {t('login.helpLost')} <code>./blackbox reset-access</code>
            </li>
            <li>{t('login.helpNoSignup')}</li>
          </ul>
        </details>
        <p className="fineprint">
          <a href={LANDING_URL}>{t('login.toGuide')}</a> · <span>{t('login.loopbackNote')}</span>
        </p>
      </main>
    </div>
  );
}
