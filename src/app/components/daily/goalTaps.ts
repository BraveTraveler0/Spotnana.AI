import { localDay } from './agenda';

// The Goals ring's + and − buttons. A rep is recorded by telling Iris (one line in her
// check-off file); she adds it to weekly-goals.json when her job next runs, which can be a
// while, and Artemis never writes that file itself. Until her file agrees, the ring shows what
// you meant: the count she had when you first tapped, plus the taps since. That is all this
// keeps, per goal, and it lets go the moment her file matches.

export interface Tap {
  // The count in Iris's file the first time this goal was tapped this week.
  base: number;
  // Taps since: + is +1, − is −1.
  net: number;
  // The Monday of the week the taps belong to; a new week starts clean.
  week: string;
}

export type Taps = Record<string, Tap>;

export const TAPS_KEY = 'artemis.daily.goalTaps';

// The Monday of the week `today` is in, as YYYY-MM-DD (local time), like the review's week.
export function weekOf(today: Date = new Date()): string {
  return localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7)));
}

const current = (taps: Taps, goalId: string, week: string): Tap | undefined => {
  const tap = taps[goalId];
  return tap && tap.week === week ? tap : undefined;
};

// What the ring shows for a goal this week: what you meant, else what Iris's file says.
export function shownDone(taps: Taps, goalId: string, fileDone: number, week: string): number {
  const tap = current(taps, goalId, week);
  return tap ? Math.max(0, tap.base + tap.net) : fileDone;
}

// A tap. A goal can't go below zero, so taking a rep off nothing changes nothing.
export function addTap(taps: Taps, goalId: string, fileDone: number, delta: 1 | -1, week: string): Taps {
  const tap = current(taps, goalId, week) ?? { base: fileDone, net: 0, week };
  if (tap.base + tap.net + delta < 0) return taps;
  return { ...taps, [goalId]: { ...tap, net: tap.net + delta } };
}

// Lets go of what no longer matters: last week's taps, taps Iris's file has caught up with
// (or that cancelled each other out), and taps for a goal that is gone. Returns the same object
// when nothing changed, so React doesn't redraw for nothing.
export function settleTaps(taps: Taps, files: { id: string; done: number }[], week: string): Taps {
  const kept: Taps = {};
  let changed = false;
  for (const [goalId, tap] of Object.entries(taps)) {
    const file = files.find((goal) => goal.id === goalId);
    if (!file || tap.week !== week || file.done === Math.max(0, tap.base + tap.net)) {
      changed = true;
      continue;
    }
    kept[goalId] = tap;
  }
  return changed ? kept : taps;
}

export function readTaps(): Taps {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TAPS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const taps: Taps = {};
    for (const [goalId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const tap = value as Partial<Tap> | null;
      if (tap && Number.isFinite(tap.base) && Number.isFinite(tap.net) && typeof tap.week === 'string') taps[goalId] = { base: Number(tap.base), net: Number(tap.net), week: tap.week };
    }
    return taps;
  } catch {
    return {};
  }
}

export function saveTaps(taps: Taps): void {
  try {
    if (Object.keys(taps).length === 0) localStorage.removeItem(TAPS_KEY);
    else localStorage.setItem(TAPS_KEY, JSON.stringify(taps));
  } catch {
    /* storage unavailable: the ring just falls back to Iris's file */
  }
}
