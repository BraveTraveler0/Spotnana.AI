import type { IrisTaskCard } from './types';
import { inferWhen, isEvergreen, stripWhen } from './whenParser';

// What the Tasks panel needs from one of Iris's cards to lay it out on a day-by-
// day agenda: the day it belongs to, its time, and the description that is left
// once the day and time are taken out of her one-line detail.
export interface Agenda {
  // Local calendar day as YYYY-MM-DD; null for a card with no date.
  day: string | null;
  // For ordering within a day; null for a card with no date.
  at: number | null;
  // "2:00 PM", or '' for an all-day or undated card.
  time: string;
  description: string;
}

export const UNDATED: Agenda = { day: null, at: null, time: '', description: '' };

const WEEKDAY = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const CLOCK = '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)';

// A piece of Iris's detail that only says when: "Tue Sep 22", "Opens Mon 11pm",
// "All weekend thru Mon", "2:00pm". "Monthly minimum" and "Sunset Cinema" are
// not, which is why the weekday and month names must end at a word boundary.
const WHEN_PART = new RegExp(
  `^(?:(?:opens?|starts?|begins?|on|at)\\s+)?(?:today|tonight|tomorrow|this\\s+(?:morning|afternoon|evening|weekend)|all\\s+(?:day|weekend|week)|${WEEKDAY}\\b|${MONTH}\\.?\\s+\\d{1,2}\\b|\\d{4}-\\d{2}-\\d{2}|${CLOCK}\\b|\\d{1,2}:\\d{2}\\b)`,
  'i',
);
const CLOCK_IN = new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b`, 'i');

function clockText(hours12: number, minutes: number, pm: boolean): string {
  return `${hours12}:${String(minutes).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
}

function clockIn(text: string): string {
  const match = text.match(CLOCK_IN);
  return match ? clockText(Number(match[1]), Number(match[2] ?? 0), match[3].toLowerCase() === 'pm') : '';
}

// Iris writes a card's detail as "day/time · venue-or-context · cost". Only the
// leading pieces that say when are dropped (the day is now the separator above
// the card and the time its own line); anything after that is the description,
// kept whole.
export function describeEvent(detail: string): { description: string; time: string } {
  const parts = detail
    .split(/\s*·\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  let time = '';
  let index = 0;
  while (index < parts.length && WHEN_PART.test(parts[index])) {
    if (!time) time = clockIn(parts[index]);
    index += 1;
  }
  return { description: parts.slice(index).join(' · '), time };
}

function parseWhen(when: string | null): { date: Date; hasTime: boolean } | null {
  const text = (when ?? '').trim();
  if (!text) return null;
  // A bare date is that day wherever you are; new Date() would read it as UTC
  // midnight, which is the evening before in the US.
  const bare = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (bare) return { date: new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])), hasTime: false };
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  // Midnight is how an all-day entry is written, not a real start time.
  const hasTime = /T\d{2}:\d{2}/.test(text) && (date.getHours() !== 0 || date.getMinutes() !== 0);
  return { date, hasTime };
}

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Which day and time a date puts something at. Something that began before
// today and is still listed (a weekend-long event, an overdue task) is happening
// today — and sorts by its clock time today, not by its original timestamp,
// which would seat yesterday 3pm ahead of today 2pm under the same day header.
function placed(when: { date: Date; hasTime: boolean }, today: Date): { day: string; at: number; time: string } {
  const now = localDay(today);
  const own = localDay(when.date);
  const hours = when.date.getHours();
  if (own < now) {
    const clamped = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours, when.date.getMinutes());
    return {
      day: now,
      at: clamped.getTime(),
      time: when.hasTime ? clockText(hours % 12 === 0 ? 12 : hours % 12, when.date.getMinutes(), hours >= 12) : '',
    };
  }
  return {
    day: own,
    at: when.date.getTime(),
    time: when.hasTime ? clockText(hours % 12 === 0 ? 12 : hours % 12, when.date.getMinutes(), hours >= 12) : '',
  };
}

export function agendaFor(card: IrisTaskCard, today: Date = new Date()): Agenda {
  const when = parseWhen(card.when);
  // Without a date the detail is all there is to say, so it stays as written.
  if (!when) return { day: null, at: null, time: '', description: card.detail.trim() };

  const { description, time: detailTime } = describeEvent(card.detail);
  const spot = placed(when, today);
  // What is left may still open with the day or a time ("Every Sunday 8pm at ...").
  return { ...spot, time: spot.time || detailTime, description: stripWhen(description) };
}

// A task you made yourself: its day and time are exact and its description is
// whatever you wrote. One taken on from an Iris suggestion that has no day of its
// own gets the one its text names ("Every Sunday 8pm (signup 7:30)"), read fresh
// each time so a weekly event always shows its next turn, and loses those words
// from its description. Weekly lessons and minimums fit any day and stay undated.
export function agendaForTask(task: { when?: string | null; note: string; label?: string; source?: string }, today: Date = new Date()): Agenda {
  const fromIris = task.source === 'Iris';
  const text = `${task.label ?? ''}. ${task.note}`;
  const when = parseWhen(task.when ?? (fromIris && !isEvergreen(text) ? inferWhen(text, today) : null));
  const note = task.note.trim();
  // With no day to put it under, its wording is the only place the day and time are kept.
  return when ? { ...placed(when, today), description: fromIris ? stripWhen(note) : note } : { day: null, at: null, time: '', description: note };
}

// Days in order, each with its entries in time order (ties keep the order they
// came in); undated entries go last as their own group.
export function groupByDay<T extends { agenda: Agenda }>(entries: T[]): { day: string | null; items: T[] }[] {
  const dated = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.agenda.day !== null)
    .sort((a, b) => {
      const dayA = a.entry.agenda.day as string;
      const dayB = b.entry.agenda.day as string;
      if (dayA !== dayB) return dayA < dayB ? -1 : 1;
      return (a.entry.agenda.at ?? 0) - (b.entry.agenda.at ?? 0) || a.index - b.index;
    });

  const groups: { day: string | null; items: T[] }[] = [];
  for (const { entry } of dated) {
    const last = groups[groups.length - 1];
    if (last && last.day === entry.agenda.day) last.items.push(entry);
    else groups.push({ day: entry.agenda.day, items: [entry] });
  }
  const undated = entries.filter((entry) => entry.agenda.day === null);
  if (undated.length > 0) groups.push({ day: null, items: undated });
  return groups;
}

// "Today · Sun, Sep 20", "Tomorrow · Mon, Sep 21", then "Tuesday · Sep 22".
export function dayLabel(day: string, today: Date = new Date()): { name: string; date: string } {
  const [year, month, dom] = day.split('-').map(Number);
  const date = new Date(year, month - 1, dom);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const offset = Math.round((date.getTime() - start.getTime()) / 86_400_000);
  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (offset === 0) return { name: 'Today', date: `${date.toLocaleDateString('en-US', { weekday: 'short' })}, ${monthDay}` };
  if (offset === 1) return { name: 'Tomorrow', date: `${date.toLocaleDateString('en-US', { weekday: 'short' })}, ${monthDay}` };
  return { name: date.toLocaleDateString('en-US', { weekday: 'long' }), date: monthDay };
}
