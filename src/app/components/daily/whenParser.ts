// Works out a day and time from the way an event is described, so a task made
// from "Every Sunday 8pm (signup 7:30) at Java Monkey" lands on Sunday at 7:30 PM
// instead of in an undated pile. It is a built-in date reader, not a language
// model: instant, private, and the same answer every time.

const WEEKDAYS: [RegExp, number][] = [
  [/\bsun(?:day)?s?\b/i, 0],
  [/\bmon(?:day)?s?\b/i, 1],
  [/\btue(?:s|sday)?s?\b/i, 2],
  [/\bwed(?:nesday)?s?\b/i, 3],
  [/\bthu(?:r|rs|rsday)?s?\b/i, 4],
  [/\bfri(?:day)?s?\b/i, 5],
  [/\bsat(?:urday)?s?\b/i, 6],
];

export const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_DAY = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
// "Sep 15–Nov 10" is a run of dates, not the day of an event: both ends are ignored.
const DATE_RANGE = new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*[–-]\\s*(?:(?:${MONTHS})\\.?\\s+)?\\d{1,2}\\b`, 'gi');

const MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "no future date currently listed", "no 2026 date yet", "date TBD", "next open slot TBD":
// the text itself says there is no day yet.
export const NO_DATE = /\bno (?:\d{4} )?(?:future |upcoming )?dates?\b|\b(?:date|dates|day|slot|time|schedule)s? (?:tbd|tba|to be (?:announced|determined)|not (?:yet )?(?:listed|announced|posted))\b/i;
// "last: Jul 30" is where something was, and "runs thru Nov 9" is where it stops: neither
// is the day to go.
const HISTORY = /\b(?:last|previous|prior|ended|was)\b[:\s,]*(?:on\s+)?$|\b(?:thru|through|until|till|ends?|ending)\s+$/i;
const RANGE = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[–-]\\s*(?:(${MONTHS})\\.?\\s+)?(\\d{1,2})\\b`, 'gi');
// Dates this close together are one event ("Sep 26–27"); further apart they are how
// long something runs ("Sep 14–Nov 9").
const EVENT_DAYS = 3;

interface Span {
  start: Date;
  end: Date;
}

// The ranges of dates in the text that have not finished yet.
function rangesIn(text: string, today: Date): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(RANGE)) {
    const first = MONTH_INDEX.indexOf(match[1].slice(0, 3).toLowerCase());
    const last = match[3] ? MONTH_INDEX.indexOf(match[3].slice(0, 3).toLowerCase()) : first;
    const from = Number(match[2]);
    const to = Number(match[4]);
    if (first < 0 || last < 0 || from < 1 || from > 31 || to < 1 || to > 31) continue;
    const start = new Date(today.getFullYear(), first, from);
    let end = new Date(today.getFullYear(), last, to);
    if (end < start) end = new Date(today.getFullYear() + 1, last, to);
    if (end >= today) spans.push({ start, end });
  }
  return spans.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

interface Clock {
  hour: number;
  minute: number;
  // am / pm when the text says so, else null until resolved from a neighbour.
  meridiem: 'am' | 'pm' | null;
  at: number;
  // "signup 7:30", "doors 6:30": the time to be there rather than the start.
  early: boolean;
}

const EARLY_LABEL = /(?:sign[- ]?up|doors?|check[- ]?in|registration|arrive)\s*(?:at|:|-)?\s*$/i;

const pad = (value: number) => String(value).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function clocksIn(text: string): Clock[] {
  const clocks: Clock[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => !taken.some(([a, b]) => start < b && end > a);
  const add = (start: number, end: number, hour: number, minute: number, meridiem: 'am' | 'pm' | null) => {
    if (hour > 24 || !free(start, end)) return;
    taken.push([start, end]);
    clocks.push({ hour, minute, meridiem, at: start, early: EARLY_LABEL.test(text.slice(Math.max(0, start - 16), start)) });
  };

  // "4:30–6:30pm" and "9–10pm": the start borrows the end's am/pm.
  for (const match of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*[–-]\s*(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?/gi)) {
    const [whole, h1, m1, h2, , ap] = match;
    const end = ap.toLowerCase() === 'p' ? 'pm' : 'am';
    const startsLater = Number(h1) % 12 > Number(h2) % 12;
    const start = startsLater ? (end === 'pm' ? 'am' : 'pm') : end;
    add(match.index ?? 0, (match.index ?? 0) + whole.length, Number(h1), Number(m1 ?? 0), start);
  }
  for (const match of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/gi)) {
    add(match.index ?? 0, (match.index ?? 0) + match[0].length, Number(match[1]), Number(match[2] ?? 0), match[3].toLowerCase() === 'p' ? 'pm' : 'am');
  }
  // "7:30" with no am/pm: which one comes from the times around it.
  for (const match of text.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)) {
    add(match.index ?? 0, (match.index ?? 0) + match[0].length, Number(match[1]), Number(match[2]), null);
  }
  for (const match of text.matchAll(/\b(noon|midnight)\b/gi)) {
    add(match.index ?? 0, (match.index ?? 0) + match[0].length, 12, 0, match[1].toLowerCase() === 'noon' ? 'pm' : 'am');
  }
  return clocks.sort((a, b) => a.at - b.at);
}

// Minutes after midnight, or null if the time can't be told (a bare "7:30" with
// nothing around it to say am or pm).
function minutesOf(clock: Clock, all: Clock[]): number | null {
  if (clock.hour >= 13 || clock.hour === 0) return clock.hour * 60 + clock.minute;
  let meridiem = clock.meridiem;
  if (!meridiem) {
    const after = all.find((other) => other.at > clock.at && other.meridiem && other.at - clock.at < 60);
    const before = [...all].reverse().find((other) => other.at < clock.at && other.meridiem && clock.at - other.at < 60);
    meridiem = (after ?? before)?.meridiem ?? null;
  }
  if (!meridiem) return null;
  const hour = (clock.hour % 12) + (meridiem === 'pm' ? 12 : 0);
  return hour * 60 + clock.minute;
}

// The time to put on it: when to be there (signup, doors) if the text gives one,
// otherwise the first time mentioned.
function timeOf(text: string): number | null {
  const clocks = clocksIn(text);
  const resolved = clocks.map((clock) => ({ clock, minutes: minutesOf(clock, clocks) })).filter((entry): entry is { clock: Clock; minutes: number } => entry.minutes !== null);
  const early = resolved.filter((entry) => entry.clock.early);
  if (early.length > 0) return Math.min(...early.map((entry) => entry.minutes));
  return resolved[0]?.minutes ?? null;
}

function explicitDate(text: string, today: Date): Date | null {
  const singles = text.replace(DATE_RANGE, ' ');
  for (const match of singles.matchAll(MONTH_DAY)) {
    if (HISTORY.test(singles.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0))) continue;
    const month = MONTH_INDEX.indexOf(match[1].slice(0, 3).toLowerCase());
    const day = Number(match[2]);
    if (month < 0 || day < 1 || day > 31) continue;
    const date = new Date(today.getFullYear(), month, day);
    return date < today ? new Date(today.getFullYear() + 1, month, day) : date;
  }
  for (const match of text.matchAll(SLASH_DATE)) {
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    const date = new Date(match[3] ? (Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3])) : today.getFullYear(), month, day);
    return !match[3] && date < today ? new Date(today.getFullYear() + 1, month, day) : date;
  }
  return null;
}

function firstWeekday(text: string): number | null {
  let best: { at: number; day: number } | null = null;
  for (const [pattern, day] of WEEKDAYS) {
    const at = text.search(pattern);
    if (at >= 0 && (!best || at < best.at)) best = { at, day };
  }
  return best ? best.day : null;
}

// The day and time an event's description points at, as "YYYY-MM-DD" or
// "YYYY-MM-DDTHH:MM" (local time), or null when it doesn't name one.
export function inferWhen(text: string, now: Date = new Date()): string | null {
  // "already passed" means the date in the text is history, not a plan; "no future
  // date listed" means there is no plan yet.
  if (/already passed/i.test(text) || NO_DATE.test(text)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const minutes = timeOf(text);
  const spans = rangesIn(text, today);

  let date = explicitDate(text, today);
  if (!date) {
    // "Sep 26–27 or Oct 17–18": the first weekend that has not ended is the day.
    const event = spans.find((span) => daysBetween(span.start, span.end) <= EVENT_DAYS);
    if (event) date = event.start < today ? today : event.start;
  }
  if (!date) {
    if (/\b(?:today|tonight)\b/i.test(text)) date = today;
    else if (/\btomorrow\b/i.test(text)) date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  }
  if (!date) {
    const weekday = firstWeekday(text);
    if (weekday === null) return null;
    // A class that has not started ("Tuesdays, Oct 6–Nov 10") first meets on or after its start.
    const run = spans.find((span) => daysBetween(span.start, span.end) > EVENT_DAYS && span.start > today);
    const from = run ? run.start : today;
    let ahead = (weekday - from.getDay() + 7) % 7;
    // Today's weekday, but that time has gone by: the next one.
    if (!run && ahead === 0 && minutes !== null && now.getHours() * 60 + now.getMinutes() >= minutes) ahead = 7;
    date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + ahead);
  }
  return minutes === null ? dayKey(date) : `${dayKey(date)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// ---- Taking the day and time out of a description -----------------------------
// Once a card sits under its day with its time on its own line, the words that
// said so ("Every Sunday 8pm (signup 7:30) at ...") are only noise in the description.

export const DAY_NAME = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?';
// "Sunday", "Wed or Thu", "Fri & Sat"
const DAY_LIST = `${DAY_NAME}(?:\\s*(?:,|/|&|\\band\\b|\\bor\\b)\\s*${DAY_NAME})*\\b`;
const CLOCK = '(?:\\d{1,2}(?::[0-5]\\d)?\\s*[ap]\\.?m\\.?|\\d{1,2}:[0-5]\\d|noon|midnight)';
// "7:30pm", "4:30–6:30pm", "9–10pm", "10pm–2am". The colon form alone is a time too.
const TIME_SPAN = `(?:\\d{1,2}(?::[0-5]\\d)?\\s*(?:[ap]\\.?m\\.?)?\\s*[–-]\\s*)?${CLOCK}(?![A-Za-z0-9])`;
const TIME_LEAD = '(?:(?:doors?|sign[- ]?up|check[- ]?in|registration|starts?|begins?|opens?|from|at|around|until|till)\\s*:?\\s*)?';

// The day and time at the very start: "Every other Sunday 4:30–6:30pm —",
// "Monday Sep 28 at", "Wed or Thu evening", "Every Sunday 8pm (signup 7:30) at".
const LEADING_WHEN = new RegExp(
  '^(?:(?:in person|opens?|starts?|begins?|held|meets?|runs?|on)\\s+)?' +
    '(?:(?:every(?:\\s+other)?|each|this|next|most)\\s+)?' +
    DAY_LIST +
    '(?:\\s+(?:cadence|nights?|evenings?|mornings?|afternoons?))?' +
    `(?:\\s*,?\\s*(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)?` +
    `(?:\\s*(?:,|at|@|from|around)?\\s*${TIME_SPAN})?` +
    '(?:\\s*\\((?=[^)]*(?::\\d\\d|\\d\\s*[ap]m))[^)]*\\))?' +
    '(?:\\s+(?:at|@)\\b)?' +
    '[\\s,;:·—–-]*',
  'i',
);
// Clock times anywhere else, with the word that introduces them ("doors 6:30",
// "at 7pm") and the comma before.
const TIME_ANYWHERE = new RegExp(`(?:,\\s*)?(?<![A-Za-z0-9])${TIME_LEAD}${TIME_SPAN}`, 'gi');

// A description without its day and time. Only the start of it and clock times
// are touched, so a sentence that merely mentions a weekday keeps it.
export function stripWhen(text: string): string {
  const cleaned = text
    .trim()
    // A bare weekday that a verb follows ("Wednesday is free entry") is a sentence
    // about that day, not a when, so it stays.
    .replace(LEADING_WHEN, (taken) => (/[\d,;:·—–-]|\b(?:every|each|most|this|next|cadence|nights?|evenings?|mornings?|afternoons?)\b/i.test(taken) ? '' : taken))
    .replace(TIME_ANYWHERE, '')
    // what a removed time leaves behind: "()", "(, x", " ,", ", )"
    .replace(/\(\s*[,;·\s]*\)/g, '')
    .replace(/\(\s*[,;]\s*/g, '(')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/,\s*(?=[,;)])/g, '')
    .replace(/\s*·\s*(?:·\s*)+/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:·—–-]+|[\s,;:·—–-]+$/g, '')
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Things that recur every week or every day and fit any of them ("Weekly
// lesson", "2 audio lessons/week", a daily routine). They belong under Anytime,
// not on the weekday a sentence happens to mention. "Every Sunday 8pm" is not
// one: that is a particular night.
export function isEvergreen(text: string): boolean {
  return /\b(?:weekly|daily|minimum|routine|ongoing)\b|\/week\b|\bper week\b|\ba week\b|\bevery day\b/i.test(text);
}

// "Sep 15–Nov 10": how long something runs. Not a day to put it on, but not "no date" either.
export function hasDateRange(text: string): boolean {
  return new RegExp(DATE_RANGE.source, 'i').test(text);
}
