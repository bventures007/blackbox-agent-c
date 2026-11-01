import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
}

/** Loads data from an async function; re-runs when deps change; optional polling interval in ms. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], pollMs?: number): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((d) => {
        if (!cancelled && alive.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled && alive.current) setError(e);
      })
      .finally(() => {
        if (!cancelled && alive.current) setLoading(false);
      });
    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollMs) {
      timer = setInterval(() => {
        loader()
          .then((d) => {
            if (!cancelled && alive.current) {
              setData(d);
              setError(null);
            }
          })
          .catch((e) => {
            if (!cancelled && alive.current) setError(e);
          });
      }, pollMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, pollMs]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const set = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setData((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater));
  }, []);
  return { data, error, loading, reload, setData: set };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}
