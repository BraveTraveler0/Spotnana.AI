import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

// Fired by Settings when the gateway address or key is saved, so the feed follows at once.
export const GATEWAY_SAVED_EVENT = 'artemis:gateway-saved';

interface Synced {
  updated: string;
  files: number;
  sent_checkoffs: number;
  checkoff_problem: string | null;
}

// A phone that is on Tailscale asks no more often than this; a failed try is retried on the
// next minute's poll.
const RESYNC_MS = 5 * 60 * 1000;

// On the phone, Iris's feed is a copy kept in the app's own storage (phone_feed.rs) and
// brought over her gateway on Tailscale. This keeps that copy fresh: when the Daily tab
// opens, when the app comes back to the front, and every few minutes while it is showing.
// `reload` re-reads the copy once it has changed. Off Tailscale nothing is lost: the last
// copy keeps showing, with a line that says so. On a computer this does nothing.
export function usePhoneFeed(active: boolean, reload: () => void) {
  const [note, setNote] = useState('');
  const [needsSettings, setNeedsSettings] = useState(false);
  const last = useRef(0);
  const busy = useRef(false);

  const sync = useCallback(
    async (force = false) => {
      if (!isAndroid || busy.current) return;
      if (!force && Date.now() - last.current < RESYNC_MS) return;
      busy.current = true;
      try {
        const result = await invoke<Synced>('sync_iris_feed');
        last.current = Date.now();
        setNeedsSettings(false);
        setNote(result.checkoff_problem ? `Iris's feed is up to date, but your check-offs are still waiting to reach her: ${result.checkoff_problem}` : '');
      } catch (err) {
        const message = String(err);
        const setup = /Settings|gateway address/i.test(message);
        setNeedsSettings(setup);
        // Nothing to fall back on yet is a setup step, not an outage.
        setNote(setup ? message : `${message} Showing the last feed this phone got.`);
      } finally {
        busy.current = false;
        reload();
      }
    },
    [reload],
  );

  useEffect(() => {
    if (!isAndroid || !active) return;
    void sync();
    const interval = setInterval(() => void sync(), 60_000);
    const back = () => {
      if (document.visibilityState === 'visible') void sync(true);
    };
    const saved = () => void sync(true);
    document.addEventListener('visibilitychange', back);
    window.addEventListener(GATEWAY_SAVED_EVENT, saved);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener(GATEWAY_SAVED_EVENT, saved);
    };
  }, [active, sync]);

  return { note, needsSettings, sync };
}
