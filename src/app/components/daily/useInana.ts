import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { InanaData } from './inana';

export interface InanaConfig {
  api_url: string;
  web_url: string;
  email: string;
  connected: boolean;
}

export type InanaStatus = 'idle' | 'loading' | 'ready' | 'expired' | 'error';

// Inana's own dashboard refreshes its evidence every 15 minutes, so polling
// faster than that would only re-read the same numbers.
const REFRESH_MS = 15 * 60 * 1000;

// `version` is bumped by the app whenever the user connects or disconnects in
// Settings, so the dashboard picks that up without waiting for the next poll.
export function useInana(enabled: boolean, version: number) {
  const [config, setConfig] = useState<InanaConfig | null>(null);
  const [data, setData] = useState<InanaData | null>(null);
  const [status, setStatus] = useState<InanaStatus>('idle');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
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
    } catch (err) {
      if (!isCurrent()) return;
      const message = String(err);
      if (message === 'inana_auth_expired') {
        hasData.current = false;
        setData(null);
        setStatus('expired');
        setError('');
      } else {
        // Keep showing stale numbers rather than blanking the panels over one
        // failed refresh.
        setStatus(hasData.current ? 'ready' : 'error');
        setError(message);
      }
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [enabled]);

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
