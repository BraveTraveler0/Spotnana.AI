import { localDay } from './agenda';
import { itemsOf, plain, sentencesOf } from './insights';
import { stripInline } from './markdown';
import type { IrisFeedSection, IrisTaskCard } from './types';
import { inferWhen, isEvergreen, stripWhen } from './whenParser';

// Iris's weekly review lists things to do (its "Local Activities", "Date
// Strategy" and "Standing Tracks" parts) as paragraphs. Each named event or track becomes a suggestion
// card, until she writes them into the feed's own suggestions herself.

// Ids start with this so the dashboard knows Iris has never heard of them.
export const REVIEW_PREFIX = 'review-';

const MAX_TITLE = 80;
const MAX_DESCRIPTION = 250;

const CATEGORIES: [RegExp, string][] = [
  [/martial|mma|jiu|boxing|muay/i, 'mma'],
  [/writ|poetry|book/i, 'writing'],
  [/surviv/i, 'survival'],
  [/paint|art|draw/i, 'art'],
  [/tech|app|code/i, 'app'],
  [/danc/i, 'dance'],
  [/comed/i, 'comedy'],
  [/language|portugu|japanese/i, 'language'],
];

const categoryOf = (label: string) => CATEGORIES.find(([match]) => match.test(label))?.[1] ?? 'other';

// Part of town and cost live inside the wording ("... in Doraville", "free lesson",
// "~$15-20"). Pull them out into their own fields so the UI can show them where
// they belong; the description keeps everything (the UI trims for display).
const AREAS = [
  'Doraville', 'Midtown', 'Downtown', 'Buckhead', 'Decatur', 'East Atlanta',
  'Old Fourth Ward', 'Inman Park', 'Virginia-Highland', 'Little Five Points',
  'Poncey-Highland', 'Edgewood', 'Kirkwood', 'Avondale Estates', 'Tucker',
  'North Druid Hills', 'Brookhaven', 'Chamblee',
];

export function extractAreaCost(description: string): { area: string | null; cost: string | null; cleaned: string } {
  let cleaned = description;
  let area: string | null = null;
  for (const name of AREAS) {
    const pattern = new RegExp(`\\b(?:in|at|near)\\s+${name}\\b`, 'i');
    if (pattern.test(cleaned)) {
      area = name;
      break;
    }
  }
  // also catch a bare trailing "(Decatur)" or "— Doraville"
  if (!area) {
    for (const name of AREAS) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(cleaned)) {
        area = name;
        break;
      }
    }
  }
  let cost: string | null = null;
  const freeMatch = cleaned.match(/\bfree\b|no cover|no cost/i);
  const priceMatch = cleaned.match(/(?:~?\$\s?\d{1,3}(?:-\s*~?\$?\d{1,3})?)/);
  if (freeMatch) cost = 'Free';
  else if (priceMatch) cost = priceMatch[0].replace(/\s+/g, '').replace('-', '-');
  return { area, cost, cleaned };
}
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The review is for a week, so a card dismissed this week comes back next week.
function weekStamp(today: Date): string {
  return localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7)));
}

function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  return `${room.slice(0, room.lastIndexOf(' ') > 0 ? room.lastIndexOf(' ') : room.length).replace(/[\s,;:—-]+$/, '')}…`;
}

const DOMAIN_IN_PARENS = /\s*\(((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^)\s]*)?)\)/i;
const ADVISORY = /^(?:none of these|nothing (?:else )?(?:lands|this)|no events?)\b/i;
// Where an event's name ends and what is said about it begins.
const DELIMITERS = [' — ', ' runs ', ' meets ', ' run ', ' has ', ' is ', ' are '];

function earliest(text: string, delimiters: string[], from: number): { at: number; width: number } | null {
  let found: { at: number; width: number } | null = null;
  for (const delimiter of delimiters) {
    const at = text.indexOf(delimiter);
    if (at >= from && (!found || at < found.at)) found = { at, width: delimiter.length };
  }
  return found;
}

// One event in a paragraph: "Java Monkey Speaks poetry open mic runs every
// Sunday 8pm ... — free, 15 min e-bike" becomes a name and a description, with
// its link taken from a URL or a bare "(site.com/page)" beside the name.
function activityCard(clause: string, label: string, week: string): IrisTaskCard | null {
  let text = clause.trim();
  let link = text.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
  text = text.replace(/https?:\/\/[^\s)]+/g, '');
  const domain = text.match(DOMAIN_IN_PARENS);
  if (domain) {
    if (!link) link = domain[1].startsWith('http') ? domain[1] : `https://${domain[1]}`;
    text = text.replace(DOMAIN_IN_PARENS, '');
  }
  text = text.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').replace(/\s+([.,;:!?)])/g, '$1').replace(/[.\s]+$/, '').trim();
  if (text.length < 4) return null;

  const split = earliest(text, DELIMITERS, 6);
  const title = clipWords(split ? text.slice(0, split.at) : text, MAX_TITLE).trim();
  const description = split ? capitalize(text.slice(split.at + split.width).trim()) : '';
  const { area, cost } = extractAreaCost(description);
  return {
    id: `${REVIEW_PREFIX}event-${slug(title)}-${week}`,
    title,
    detail: clipWords(description, MAX_DESCRIPTION),
    source: 'iris',
    category: categoryOf(label),
    area,
    cost,
    when: null,
    link,
    goal_id: null,
    action: 'accept',
  };
}

// "**Writing:** A meets on Saturday; B runs every Sunday. None of these land
// this week." is two events; the closing remark is not one.
function activityCards(paragraph: string, week: string): IrisTaskCard[] {
  const labelled = paragraph.match(/^\*\*([^*]+?):?\*\*:?\s*([\s\S]*)$/);
  const label = labelled ? labelled[1].trim() : '';
  const body = stripInline(labelled ? labelled[2] : paragraph).replace(/\s+/g, ' ').trim();

  const clauses: string[] = [];
  for (const sentence of sentencesOf(body)) {
    if (ADVISORY.test(sentence)) continue;
    for (const clause of sentence.split(/;\s+/)) {
      // "also BJJ and kickboxing on the same schedule" belongs to the event before it.
      if (/^[a-z]/.test(clause) && clauses.length > 0) clauses[clauses.length - 1] += `; ${clause}`;
      else clauses.push(clause);
    }
  }
  return clauses.map((clause) => activityCard(clause, label, week)).filter((card): card is IrisTaskCard => card !== null);
}

// The first sentences that fit in `max` characters.
function head(text: string, max: number): string {
  const sentences = sentencesOf(text);
  let out = '';
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  return capitalize(out || clipWords(sentences[0] ?? '', max));
}

// One of the "Date Strategy" picks: "**Timeleft dinner (Wednesday cadence) —
// the wildcard.** Five strangers, one table, ... https://timeleft.com/" or the
// runner-up line. The bold lead names it; what follows says what it is.
function pickCard(item: string, week: string): IrisTaskCard | null {
  const runnerUp = item.match(/^\*\*the runner-up:?\*\*:?\s*([\s\S]*)$/i);
  const led = item.match(/^\*\*([^*]+?)\*\*\s*([\s\S]*)$/);
  if (!runnerUp && !led) return null;

  const raw = runnerUp ? runnerUp[1] : item;
  const link = raw.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;

  let title: string;
  let description: string;
  if (runnerUp) {
    const text = plain(runnerUp[1]).replace(/[:\s]+$/, '');
    const comma = text.indexOf(', ');
    title = comma > 0 ? text.slice(0, comma) : text;
    description = comma > 0 ? capitalize(text.slice(comma + 2)) : '';
  } else {
    const lead = stripInline(led![1]);
    const paren = lead.indexOf(' (');
    const dash = lead.indexOf(' — ');
    const cut = paren >= 6 ? paren : dash >= 6 ? dash : -1;
    title = (cut >= 0 ? lead.slice(0, cut) : lead).replace(/[.\s]+$/, '');
    const remainder = (cut >= 0 ? lead.slice(cut).trim() : '').replace(/^\(([^)]*)\)\s*/, '$1 ').replace(/^—\s*/, '');
    description = head(plain(`${remainder} ${led![2]}`), MAX_DESCRIPTION);
  }
  if (title.length < 4) return null;
  const { area, cost } = extractAreaCost(description);
  return {
    id: `${REVIEW_PREFIX}date-${slug(title)}-${week}`,
    title: clipWords(title, MAX_TITLE),
    detail: clipWords(description, MAX_DESCRIPTION),
    source: 'iris',
    category: 'social',
    area,
    cost,
    when: null,
    link,
    goal_id: null,
    action: 'accept',
  };
}

// The last sentences that fit: for a status-then-next-step paragraph, the next
// step is what is worth suggesting.
function tail(text: string, max: number): string {
  const sentences = sentencesOf(text);
  let out = '';
  for (let index = sentences.length - 1; index >= 0; index--) {
    const next = out ? `${sentences[index]} ${out}` : sentences[index];
    if (next.length > max) break;
    out = next;
  }
  return capitalize(out || clipWords(sentences[sentences.length - 1] ?? '', max));
}

// "**MMA** — Weekly lesson: held all week ... A natural slot: ..." becomes
// "MMA — Weekly lesson" with the next step as its description.
function trackCard(paragraph: string, week: string): IrisTaskCard | null {
  const text = plain(paragraph);
  const labelled = text.match(/^([^—]+?)\s+—\s+([\s\S]*)$/);
  if (!labelled) return null;
  const label = labelled[1].trim();
  const rest = labelled[2].trim();
  const split = earliest(rest, [': ', ' — ', ' shows ', ' is '], 3);
  const topic = split ? rest.slice(0, split.at) : rest;
  const description = tail(split ? rest.slice(split.at + split.width) : '', MAX_DESCRIPTION);
  const title = clipWords(`${label} — ${topic}`, MAX_TITLE);
  const { area, cost } = extractAreaCost(description);
  return {
    id: `${REVIEW_PREFIX}track-${slug(label)}-${week}`,
    title,
    detail: description,
    source: 'iris',
    category: categoryOf(label),
    area,
    cost,
    when: null,
    link: null,
    goal_id: null,
    action: 'accept',
  };
}

// A card's day and time come out of its wording: it goes under that day with its
// time on its own line, and the description keeps what is left ("Java Monkey
// Coffeehouse, Decatur — free, 15 min e-bike"). Weekly lessons and minimums fit
// any day, so they stay undated and wait under Anytime.
function scheduled(card: IrisTaskCard, today: Date): IrisTaskCard {
  const detail = card.detail.replace(/^(?:a natural slot|best slot)\s*:\s*/i, '');
  const text = `${card.title}. ${detail}`;
  return { ...card, detail: stripWhen(detail), when: isEvergreen(text) ? null : inferWhen(text, today) };
}

// What a weekly count says about itself ("0 of 2 done") is Iris's own goal card
// in Next, kept current; a copy here would only go stale.
const STATUS_ONLY = /^\s*\d+\s+of\s+\d+\b/i;

// The place an activity is at: "Muay Thai at Unit 2 Fitness (Decatur)" is "unit 2 fitness".
function placeOf(title: string): string {
  const at = title.lastIndexOf(' at ');
  const name = (at > 0 ? title.slice(at + 4) : title).replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
  return name.length >= 8 ? name : '';
}

const mentions = (card: IrisTaskCard, place: string) => place !== '' && `${card.title} ${card.detail}`.toLowerCase().includes(place);

// Two lines of the review that name the same place are one suggestion: the weekly
// MMA lesson "at Unit 2 Fitness" and the Muay Thai listing for Unit 2 Fitness.
// The standing track wins, since it says what the week needs; it borrows the
// listing's link if it has none.
function mergeSamePlace(cards: IrisTaskCard[]): IrisTaskCard[] {
  const kept: IrisTaskCard[] = [];
  for (const card of cards) {
    const twin = kept.findIndex((other) => mentions(other, placeOf(card.title)) || mentions(card, placeOf(other.title)));
    if (twin < 0) {
      kept.push(card);
      continue;
    }
    const other = kept[twin];
    const winner = card.id.includes('-track-') && !other.id.includes('-track-') ? card : other;
    const loser = winner === card ? other : card;
    kept[twin] = { ...winner, link: winner.link ?? loser.link };
  }
  return kept;
}

export function reviewSuggestions(sections: IrisFeedSection[], today: Date = new Date()): IrisTaskCard[] {
  const week = weekStamp(today);
  const cards: IrisTaskCard[] = [];
  for (const section of sections) {
    if (/local activit/i.test(section.heading)) {
      for (const item of itemsOf(section.content)) cards.push(...activityCards(item, week));
    } else if (/date strategy/i.test(section.heading)) {
      for (const item of itemsOf(section.content)) {
        const card = pickCard(item, week);
        if (card) cards.push(card);
      }
    } else if (/standing tracks?/i.test(section.heading)) {
      for (const item of itemsOf(section.content)) {
        const card = trackCard(item, week);
        if (card && !STATUS_ONLY.test(card.detail)) cards.push(card);
      }
    }
  }
  const seen = new Set<string>();
  const unique = cards.filter((card) => (seen.has(card.id) ? false : (seen.add(card.id), true)));
  return mergeSamePlace(unique).map((card) => scheduled(card, today));
}
