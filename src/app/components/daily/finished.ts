import type { IrisTaskCard } from './types';

// Next cards are numbered by position ("next-1"), so the same id can be a
// different card tomorrow. The title ties a choice to the card it was made on.
export const cardKey = (card: IrisTaskCard) => `${card.id}::${card.title}`;

// A card you checked off, kept on this machine: Iris owns the feed and Artemis
// never writes to it.
export interface FinishedEntry {
  at: number;
  card: IrisTaskCard;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a finished card stays out of Next and listed under Done. The cards
// Iris writes only look a week ahead, so a longer memory would just risk hiding a
// later card that happens to share a title.
export const FINISHED_VISIBLE_MS = 8 * DAY_MS;

// "0 of 2 done this week": a weekly minimum is an ongoing commitment with a
// count, not a task that is completed once and disappears.
export interface Progress {
  done: number;
  target: number;
}

const PROGRESS = /\b(\d+)\s+of\s+(\d+)\b/i;

export function progressOf(detail: string): Progress | null {
  const match = detail.match(PROGRESS);
  return match ? { done: Number(match[1]), target: Number(match[2]) } : null;
}

export function withProgress(detail: string, done: number): string {
  return detail.replace(PROGRESS, (_whole, _done, target) => `${Math.min(done, Number(target))} of ${target}`);
}

function mondayOf(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
}

// Recurring events reuse a title week after week, but not the day it falls on.
const finishedKey = (card: IrisTaskCard) => `${cardKey(card)}::${card.when ?? ''}`;

export function recentlyFinished(finished: FinishedEntry[], now: Date = new Date()): FinishedEntry[] {
  return finished.filter((entry) => entry.at > now.getTime() - FINISHED_VISIBLE_MS).sort((a, b) => b.at - a.at);
}

// The cards with the ones you have finished taken out. A goal card counts the
// reps you logged since Iris last wrote the feed (her own count already has
// anything from before) and stays until the target is met, showing the new count;
// any other card is gone once finished.
export function withoutFinished(cards: IrisTaskCard[], finished: FinishedEntry[], since: number, now: Date = new Date()): IrisTaskCard[] {
  const recent = recentlyFinished(finished, now);
  if (recent.length === 0) return cards;
  const floor = Math.max(since, mondayOf(now));
  return cards.flatMap((card) => {
    if (card.goal_id) {
      const reps = recent.filter((entry) => entry.card.goal_id === card.goal_id && entry.at > floor).length;
      if (reps === 0) return [card];
      const progress = progressOf(card.detail);
      // No count to reach: one rep does it, until Iris writes the card again.
      if (!progress || progress.done + reps >= progress.target) return [];
      return [{ ...card, detail: withProgress(card.detail, progress.done + reps) }];
    }
    return recent.some((entry) => !entry.card.goal_id && finishedKey(entry.card) === finishedKey(card)) ? [] : [card];
  });
}
