import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { InanaData } from './inana';

export interface InanaConfig {
  api_url: string;
  web_url: string;
  email: string;
  // Artemis has an access token for Inana (made once by scripts/inana-token.mjs; there is
  // no sign-in and no password).
  connected: boolean;
}

export type InanaStatus = 'idle' | 'loading' | 'ready' | 'expired' | 'error';

// Inana's own dashboard refreshes its evidence every 15 minutes, so polling
// faster than that would only re-read the same numbers.
const REFRESH_MS = 15 * 60 * 1000;
// While Inana can't be reached (its server may simply not be running yet), try
// again rather than waiting for the next refresh: 20 seconds, then 40, 80, ... up
// to 5 minutes between tries.
const RETRY_BASE_MS = 20 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

export const retryDelay = (failures: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));

// `version` is bumped by the app whenever the user connects or disconnects in
// Settings, so the dashboard picks that up without waiting for the next poll.
export function useInana(enabled: boolean, version: number) {
  const [config, setConfig] = useState<InanaConfig | null>(null);
  const [data, setData] = useState<InanaData | null>(null);
  const [status, setStatus] = useState<InanaStatus>('idle');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Failed tries in a row with nothing to show, for the retry delay.
  const [failures, setFailures] = useState(0);
  const latestRequest = useRef(0);
  const hasData = useRef(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++latestRequest.current;
    const isCurrent = () => requestId === latestRequest.current;

    let nextConfig: InanaConfig;
    try {
      nextConfig = await invoke<InanaConfig>('get_inana_config');
    } catch (err) {
      if (isCurrent()) {
        setStatus('error');
        setError(String(err));
        setFailures((count) => count + 1);
      }
      return;
    }
    if (!isCurrent()) return;
    setConfig(nextConfig);

    if (!nextConfig.connected) {
      hasData.current = false;
      setData(null);
      setStatus('idle');
      setError('');
      return;
    }

    // A refresh keeps whatever is already on screen; only a first load shows
    // the loading state.
    if (hasData.current) setRefreshing(true);
    else setStatus('loading');

    try {
      const result = await invoke<InanaData>('fetch_inana_data');
      if (!isCurrent()) return;
      hasData.current = true;
      setData(result);
      setStatus('ready');
      setError('');
      setFailures(0);
    } catch (err) {
      if (!isCurrent()) return;
      const message = String(err);
      if (message === 'inana_auth_expired') {
        hasData.current = false;
        setData(null);
        setStatus('expired');
        setError('');
      } else if (message === 'inana_not_connected') {
        hasData.current = false;
        setData(null);
        setStatus('idle');
        setError('');
      } else {
        // Keep showing stale numbers rather than blanking the panels over one
        // failed refresh.
        setStatus(hasData.current ? 'ready' : 'error');
        setError(message);
        if (!hasData.current) setFailures((count) => count + 1);
      }
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [enabled]);

  // Keep trying while there is nothing to show and Inana can't be reached.
  useEffect(() => {
    if (!enabled || status !== 'error') return;
    const timer = setTimeout(load, retryDelay(failures));
    return () => clearTimeout(timer);
  }, [enabled, status, failures, load]);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      clearInterval(interval);
      latestRequest.current++;
    };
  }, [load, version]);

  return { config, data, status, error, refreshing, refresh: load };
}
