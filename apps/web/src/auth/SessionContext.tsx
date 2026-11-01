import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { HttpError, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { auth, workspace as workspaceApi } from '../api/endpoints';
import type { Locale, SessionInfo, Workspace } from '../api/types';
import { applyLocale, initialLocale } from '../i18n';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface SessionContextValue {
  status: Status;
  session: SessionInfo | null;
  workspace: Workspace | null;
  locale: Locale;
  refresh: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  login: (key: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  setLocale: (locale: Locale) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const refreshWorkspace = useCallback(async () => {
    try {
      setWorkspace(await workspaceApi.get());
    } catch {
      // keep last known workspace
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await auth.session();
      setCsrfToken(s.csrf_token);
      setSession(s);
      setStatus('authenticated');
      setLocaleState(s.workspace.locale);
      applyLocale(s.workspace.locale);
      await refreshWorkspace();
    } catch (e) {
      setCsrfToken(null);
      setSession(null);
      setWorkspace(null);
      setStatus('anonymous');
      if (!(e instanceof HttpError && e.status === 401)) {
        // network or server failure: still anonymous, the login view reports connectivity
      }
    }
  }, [refreshWorkspace]);

  useEffect(() => {
    applyLocale(locale);
    void refresh();
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setSession(null);
      setWorkspace(null);
      setStatus('anonymous');
    });
    return () => setUnauthorizedHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (key: string, remember: boolean) => {
      await auth.login(key, remember);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      setCsrfToken(null);
      setSession(null);
      setWorkspace(null);
      setStatus('anonymous');
    }
  }, []);

  const setLocale = useCallback(
    async (next: Locale) => {
      setLocaleState(next);
      applyLocale(next);
      if (status === 'authenticated') {
        try {
          const w = await workspaceApi.patch({ locale: next });
          setWorkspace(w);
        } catch {
          // local preference still applied
        }
      }
    },
    [status],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, session, workspace, locale, refresh, refreshWorkspace, login, logout, setLocale }),
    [status, session, workspace, locale, refresh, refreshWorkspace, login, logout, setLocale],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
