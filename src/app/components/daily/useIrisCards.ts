import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cardKey, type FinishedEntry } from './finished';
import type { IrisTaskCard } from './types';

export { cardKey };

const HANDLED_KEY = 'artemis.daily.handledCards';
const FINISHED_KEY = 'artemis.daily.finishedCards';
const SCOUT_KEY = 'artemis.daily.scoutAskedAt';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// Iris usually takes a few minutes; after this long it is fair to ask again.
const SCOUT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface HandledEntry {
  at: number;
  kind: 'dismissed' | 'accepted';
  card: IrisTaskCard;
}

function loadHandled(): Record<string, HandledEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? '{}') as Record<string, HandledEntry>;
    const cutoff = Date.now() - KEEP_MS;
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => entry && entry.at > cutoff && entry.card));
  } catch {
    return {};
  }
}

function saveHandled(handled: Record<string, HandledEntry>) {
  try {
    localStorage.setItem(HANDLED_KEY, JSON.stringify(handled));
  } catch {
    /* storage unavailable: the choice just won't outlive this session */
  }
}

// Which of Iris's cards the user has already dismissed or accepted. Iris owns
// the feed and Artemis never writes to it, so this is remembered on this machine.
export function useHandledCards() {
  const [handled, setHandled] = useState(loadHandled);

  const mark = useCallback((card: IrisTaskCard, kind: HandledEntry['kind']) => {
    setHandled((previous) => {
      const next = { ...previous, [cardKey(card)]: { at: Date.now(), kind, card } };
      saveHandled(next);
      return next;
    });
  }, []);

  return {
    handled,
    dismiss: useCallback((card: IrisTaskCard) => mark(card, 'dismissed'), [mark]),
    markAccepted: useCallback((card: IrisTaskCard) => mark(card, 'accepted'), [mark]),
  };
}

function loadFinished(): FinishedEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FINISHED_KEY) ?? '[]') as FinishedEntry[];
    const cutoff = Date.now() - KEEP_MS;
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.at > cutoff && entry.card) : [];
  } catch {
    return [];
  }
}

function saveFinished(finished: FinishedEntry[]) {
  try {
    localStorage.setItem(FINISHED_KEY, JSON.stringify(finished));
  } catch {
    /* storage unavailable: the check just won't outlive this session */
  }
}

// The cards you have checked off. Like the dismissed ones they are remembered on
// this machine, since the feed is Iris's alone to write. `undo` takes one back.
export function useFinishedCards() {
  const [finished, setFinished] = useState(loadFinished);

  const finish = useCallback((card: IrisTaskCard) => {
    const at = Date.now();
    setFinished((previous) => {
      const next = [...previous, { at, card }];
      saveFinished(next);
      return next;
    });
  }, []);

  const undo = useCallback((entry: FinishedEntry) => {
    setFinished((previous) => {
      const next = previous.filter((other) => !(other.at === entry.at && cardKey(other.card) === cardKey(entry.card)));
      saveFinished(next);
      return next;
    });
  }, []);

  return { finished, finish, undo };
}

export type ScoutState = 'idle' | 'sending' | 'asked';

function recentlyAsked(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(SCOUT_KEY) ?? 0) < SCOUT_COOLDOWN_MS;
  } catch {
    return false;
  }
}

// The user-initiated "look for events now" request. Whatever Iris finds comes
// back through the feed like any other suggestion.
export function useScoutRequest() {
  const [state, setState] = useState<ScoutState>(() => (recentlyAsked() ? 'asked' : 'idle'));
  const [error, setError] = useState('');

  const ask = useCallback(async () => {
    setState('sending');
    setError('');
    try {
      await invoke('ask_iris_to_scout');
      try {
        localStorage.setItem(SCOUT_KEY, String(Date.now()));
      } catch {
        /* the button just won't remember it was pressed */
      }
      setState('asked');
    } catch (err) {
      setError(String(err));
      setState('idle');
    }
  }, []);

  return { state, error, ask };
}
