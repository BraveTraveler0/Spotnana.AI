import { stripInline } from './markdown';
import { extractAreaCost } from './place';
import { DAY_NAME, MONTHS, NO_DATE, inferWhen, isEvergreen } from './whenParser';

// The activity paragraphs of Iris's weekly review list their events as numbered
// entries:
//
//   **Painting:** three real options this fall. (1) **Chastain Arts Center — Basic
//   Drawing for Beginners** — Mondays 1:30–4:30pm, Sep 14–Nov 9 (9 weeks), hosted by
//   the City of Atlanta ..., CAC Gallery Studio, 135 Chastain Park Ave NW, Buckhead,
//   $240: https://... (2) **Callanwolde Figure Drawing** — ...
//
// Each entry is one card: the bold name is the title, and the wording after it is
// sorted into when, where, who hosts it and what it costs, the four things the
// card has to show without a click.

export interface EventEntry {
  title: string;
  // Everything the card says under its title, as short pieces joined by " · ".
  detail: string;
  // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", or null when the entry gives no day to put it on.
  when: string | null;
  area: string | null;
  cost: string | null;
  link: string | null;
}

export const MAX_TITLE = 80;
const MAX_DETAIL = 260;
// A leftover remark ("8 students max") longer than this is not worth a card's space.
const MAX_EXTRA = 70;
const MIN_EXTRA = 6;
const MAX_EXTRAS = 4;

export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  return `${room.slice(0, room.lastIndexOf(' ') > 0 ? room.lastIndexOf(' ') : room.length).replace(/[\s,;:—-]+$/, '')}…`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A bare "(site.com/page)" beside a name stands in for a link.
export const DOMAIN_IN_PARENS = /\s*\(((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^)\s]*)?)\)/i;

const URL = /https?:\/\/[^\s)]+/;
const ENTRY_MARK = /\(\d{1,2}\)\s+(?=\*\*)/g;

// How far away it is, and what already happened, are not part of a card:
// "(northwest ATL, ~35 min from Tucker)", "(last: Jul 30 ... downtown)".
const ASIDE = /\s*\((?:[^()]*\b(?:from|to)\s+Tucker\b[^()]*|[^()]*~\s*\d+\s*(?:min|hr|hour)[^()]*|(?:last|previous|prior)\b[^()]*)\)/gi;
// "— LOCATION: Madison, NOT Tucker, ~1hr15 drive from home (overnight)": how far, not what.
const LOCATION_NOTE = /\s*(?:[—–-]\s*)?LOCATION:[^;()]*?\bfrom (?:home|Tucker)\b(?:\s*\([^)]*\))?/gi;
// A period that ends a sentence, not one in "Rd." or "Inc.".
const SENTENCE_END = /(?<=[a-z0-9)])\.\s+(?=[A-Z$~])/g;
const ABBREVIATION = /\b(?:Rd|St|Ave|Dr|Blvd|Ln|Ct|Pl|Pkwy|Hwy|Mt|Ft|No|Jr|Sr|Inc|Ltd|vs|etc|approx)$/i;

const CLOCK = /\b\d{1,2}(?::[0-5]\d)?\s*[ap]\.?m\.?(?![A-Za-z])|\b\d{1,2}:[0-5]\d\b|\b(?:noon|midnight)\b/i;
const WHEN_WORDS = new RegExp(
  `\\b${DAY_NAME}\\b|\\b(?:${MONTHS})\\.?\\s+\\d{1,2}\\b|\\b(?:monthly|weekly|biweekly|daily|nightly)\\b|\\bevery\\b|\\b(?:today|tonight|tomorrow)\\b`,
  'i',
);
const ADDRESS = /^\d{1,5}\s+\S.*\b(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Pkwy|Parkway|Way|Ln|Lane|Ct|Court|Hwy|Pl|Place|Pike|Trl|Trail|Cir|Circle)\b/i;
const COST_LEAD = /^(?:~?\$\s?\d|free\b|no cover\b|no charge\b|donation|pay what)/i;
const HOST_LEAD = /^hosted by\s+/i;
const STAFF_LEAD = /^(?:(?:taught|led|instructed|guided|presented|organi[sz]ed) by|lead instructors?|instructors?|with)\b/i;
// A part of town, a city, a state (and its zip): what follows a street address.
const PLACE_TOKEN = /^[A-Z][\w.'’-]*(?: [A-Z][\w.'’-]*){0,2}(?: \d{5}(?:-\d{4})?)?$/;
const MULTI_DAY = new RegExp(`[–-]\\s*((?:${DAY_NAME})\\s+(?:${MONTHS})\\.?\\s+\\d{1,2})`, 'i');
const RUNS_THROUGH = new RegExp(`\\b(?:thru|through|until|till|ends?)\\s+((?:(?:${DAY_NAME})\\s+)?(?:${MONTHS})\\.?\\s+\\d{1,2})(\\s*\\([^)]*\\))?`, 'i');

const MONTH_RANGE = new RegExp(
  `\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[–-]\\s*(?:(${MONTHS})\\.?\\s+)?(\\d{1,2})\\b(?:\\s*\\((\\d+)\\s+weeks?\\))?`,
  'i',
);
const MONTH_DAY = new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}\\b`, 'gi');
const CADENCE = /\b(?:monthly|weekly|biweekly)\b|\bevery\s+(?:other\s+)?(?:\d(?:st|nd|rd|th)(?:\s*(?:&|and)\s*\d(?:st|nd|rd|th))?\s+)?[a-z]+day\b/i;

const readable = (markdown: string) => stripInline(markdown).replace(/\s+/g, ' ').trim();

// Splits at the given marks (a comma or a semicolon followed by a space) that are
// not inside parentheses, so "(9 weeks)" and "(~1hr from Tucker, camping)" stay whole.
function splitOutside(text: string, marks: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && marks.includes(char) && /\s/.test(text[index + 1] ?? ' ')) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// One statement as its sentences: "..., Watkinsville GA. $156 weekend pass ..." is two.
function sentencesIn(statement: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of statement.matchAll(SENTENCE_END)) {
    const before = statement.slice(start, match.index);
    if (ABBREVIATION.test(before)) continue;
    parts.push(before);
    start = (match.index ?? 0) + match[0].length;
  }
  parts.push(statement.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// 'lead' says what the event is ("the annual product-management unconference"); 'venue' is a
// place named inside another statement ("hosted by X at his HQ").
type Kind = 'host' | 'staff' | 'cost' | 'when' | 'address' | 'venue' | 'lead' | 'other';

interface Piece {
  text: string;
  kind: Kind;
  // Which "; "-separated statement it came from: a venue never runs across two.
  fact: number;
}

function kindOf(text: string): Kind {
  if (HOST_LEAD.test(text)) return 'host';
  if (STAFF_LEAD.test(text)) return 'staff';
  if (COST_LEAD.test(text)) return 'cost';
  if (ADDRESS.test(text)) return 'address';
  if (NO_DATE.test(text) || WHEN_WORDS.test(text) || CLOCK.test(text)) return 'when';
  return 'other';
}

// Who hosts it, from "hosted by the all-volunteer Civic Tech Atlanta (Code for
// America network)" or "hosted by Byron Kerns (ex-Air Force SERE) at his HQ".
function hostOf(piece: string): { host: string; at: string } {
  const [, named, at = ''] = piece.replace(HOST_LEAD, '').match(/^(.+?)(?:\s+at\s+(.+))?$/i) ?? ['', ''];
  const host = named
    .replace(/\s*\([^)]*\)/g, '')
    .split(/\s+with\s+/i)[0]
    .replace(/^the\s+/i, '')
    .replace(/^all[- ]volunteer\s+/i, '')
    .trim();
  return { host, at: at.replace(/\s*\([^)]*\)/g, '').trim() };
}

// A remark that the entry conflicts with the workday, kept short. Anything else
// a warning says is left for the link.
function warningOf(text: string): string | null {
  return /conflict|work[- ]hours|9[–-]5|daytime|weekday|lunch/i.test(text) ? '⚠ Conflicts with work hours' : null;
}

// "Runs Sep 14–Nov 9 (9 weeks)" for a class that goes on for a while; the dates
// themselves when there are a few to pick from ("Next dates Sep 26–27 or Oct 17–18");
// else how often it happens. The day it lands on is the card's day, so a single
// date is not repeated.
function scheduleNote(when: string[]): string | null {
  const text = when.join(', ');
  for (const piece of when) {
    const range = piece.match(MONTH_RANGE);
    if (range && (range[3] || Number(range[4]) - Number(range[2]) > 3)) return `Runs ${range[0].replace(/\s+/g, ' ')}`;
  }
  // "Fri Nov 6 – Sun Nov 8": the card sits on the first day and says how far it goes.
  const through = text.match(MULTI_DAY);
  if (through) return `Through ${through[1]}`;
  // "runs thru Nov 9 (time on registration page)": where a class stops, said as it was.
  const stops = text.match(RUNS_THROUGH);
  if (stops) return `Runs through ${stops[1]}${stops[2] ?? ''}`;
  const listed = when.find((piece) => (piece.match(MONTH_DAY) ?? []).length >= 2);
  if (listed) return capitalize(listed);
  const cadence = text.match(CADENCE);
  return cadence ? capitalize(cadence[0]) : null;
}

function venueOf(pieces: Piece[], area: string | null): { venue: string; used: Set<number> } | null {
  let anchor = pieces.findIndex((piece) => piece.kind === 'address' || piece.kind === 'venue');
  // No street address: the part of town, when it is a statement of its own ("Piedmont Park,
  // Midtown"), still says where the name in front of it is.
  if (anchor < 0 && area) anchor = pieces.findIndex((piece) => piece.kind === 'other' && piece.text.toLowerCase() === area.toLowerCase());
  if (anchor < 0) return null;
  const used = new Set<number>([anchor]);
  const parts = [pieces[anchor].text];
  // The name in front of the address ("CAC Gallery Studio, 135 Chastain Park Ave NW").
  for (let index = anchor - 1; index >= 0 && anchor - index <= 2; index--) {
    const piece = pieces[index];
    if (piece.kind !== 'other' || piece.fact !== pieces[anchor].fact || piece.text.length > 60) break;
    parts.unshift(piece.text);
    used.add(index);
  }
  // After it: the address, when what came first was only "at their farm", then the part
  // of town or city.
  const home = pieces[anchor];
  const follows = (piece: Piece | undefined, kind: Kind) => piece !== undefined && piece.kind === kind && piece.fact === home.fact;
  let after = anchor + 1;
  if (home.kind === 'venue' && follows(pieces[after], 'address')) {
    parts.push(pieces[after].text);
    used.add(after);
    after += 1;
  }
  if (follows(pieces[after], 'other') && PLACE_TOKEN.test(pieces[after].text)) {
    parts.push(pieces[after].text);
    used.add(after);
  }
  const venue = capitalize(
    parts
      .join(', ')
      .replace(/^(?:at|in)\s+/i, '')
      .replace(/^(?:the|their|his|her)\s+/i, '')
      .replace(/,\s*(?:at|in)\s+(?:the|their|his|her)\s+/gi, ', '),
  );
  return { venue, used };
}

export function parseEntry(segment: string, today: Date): EventEntry | null {
  const led = segment.trim().match(/^\*\*([^*]+)\*\*\s*(?:[—–-]+\s*)?([\s\S]*)$/);
  if (!led) return null;
  // "**Standalone classes, honest status:**" labels a remark about the options, not an event.
  if (/:\s*$/.test(led[1].trim())) return null;
  let name = readable(led[1]);
  // "Fall Gathering — Fri Nov 6 – Sun Nov 8, 2026": the dates are when, not part of the name.
  let dated = '';
  const dash = name.lastIndexOf(' — ');
  if (dash > 0 && kindOf(name.slice(dash + 3)) === 'when' && kindOf(name.slice(0, dash)) !== 'when') {
    dated = name.slice(dash + 3);
    name = name.slice(0, dash);
  }
  const title = clipWords(name, MAX_TITLE);
  if (title.length < 4) return null;

  // "up to the link" is the entry; a note after it ("— note both slots are DAYTIME")
  // is kept only as a warning.
  const body = `${dated ? `${dated}, ` : ''}${led[2]}`.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2');
  const url = body.match(URL);
  const head = url ? body.slice(0, url.index) : body;
  const after = url ? body.slice((url.index ?? 0) + url[0].length) : '';
  let link = url ? url[0].replace(/[.,;:!?]+$/, '') : null;
  let text = readable(head).replace(ASIDE, '').replace(LOCATION_NOTE, '');
  if (!link) {
    const domain = text.match(DOMAIN_IN_PARENS);
    if (domain) {
      link = domain[1].startsWith('http') ? domain[1] : `https://${domain[1]}`;
      text = text.replace(DOMAIN_IN_PARENS, '');
    }
  }
  // Whatever led up to the link ("so watch", "register at") goes with it.
  text = text
    .replace(/(?:,?\s+(?:so\s+)?(?:watch|see|check|book|register|tickets?|details?|info|sign up|more|at|on|via|or))+\s*[:,;]?\s*$/i, '')
    .replace(/[\s:,;—–-]+$/, '');

  const warnings: string[] = [];
  const facts = splitOutside(text, ';').flatMap(sentencesIn).map((fact) => {
    const flagged = fact.match(/^(.*?)\s*(?:[—–-]\s*)?⚠️?\s*(.*)$/);
    if (!flagged) return fact;
    const warning = warningOf(flagged[2]);
    if (warning) warnings.push(warning);
    return flagged[1];
  });
  const noted = after.match(/^\s*(?:[—–-]\s*)?(?:note\b[:\s]*|⚠️?\s*)([^.]*)/i);
  const afterWarning = noted ? warningOf(noted[1]) : null;
  if (afterWarning) warnings.push(afterWarning);

  const pieces: Piece[] = [];
  facts.forEach((fact, index) => {
    for (const piece of splitOutside(fact, ',')) {
      // "the annual product-management unconference: Sat Nov 13" is what it is, then when.
      const lead = piece.match(/^([^:]{6,80}?):\s+(.+)$/);
      if (lead && kindOf(lead[1]) === 'other' && kindOf(lead[2]) === 'when') {
        pieces.push({ text: lead[1], kind: 'lead', fact: index }, { text: lead[2], kind: 'when', fact: index });
      } else {
        pieces.push({ text: piece, kind: kindOf(piece), fact: index });
      }
    }
  });

  // "hosted by Byron Kerns at his HQ outside Madison" names a host and a place.
  let host = '';
  const hostAt = pieces.findIndex((piece) => piece.kind === 'host');
  if (hostAt >= 0) {
    const parsed = hostOf(pieces[hostAt].text);
    host = parsed.host;
    pieces[hostAt].text = `hosted by ${host}`;
    if (parsed.at) pieces.splice(hostAt + 1, 0, { text: parsed.at, kind: 'venue', fact: pieces[hostAt].fact });
  }

  const { area, cost } = extractAreaCost(text);
  const where = venueOf(pieces, area);
  const used = where?.used ?? new Set<number>();
  return compose(
    {
      title,
      lead: pieces.filter((piece) => piece.kind === 'lead').map((piece) => piece.text),
      when: pieces.filter((piece) => piece.kind === 'when').map((piece) => piece.text),
      whenText: text,
      venue: where?.venue ?? '',
      host,
      warnings,
      extras: pieces.filter((piece, index) => piece.kind === 'other' && !used.has(index)).map((piece) => piece.text),
      area,
      cost,
      link,
    },
    today,
  );
}

// What an entry says, sorted, by either reader below.
interface Parts {
  title: string;
  // What it is ("the annual product-management unconference").
  lead: string[];
  // The wording about its day and time, and everything the date reader may look at.
  when: string[];
  whenText: string;
  venue: string;
  host: string;
  warnings: string[];
  // Leftover remarks ("8 students max"), in the order they came.
  extras: string[];
  area: string | null;
  cost: string | null;
  link: string | null;
}

const brief = (piece: string) => (piece.length > MAX_EXTRA && piece.includes(' — ') ? piece.split(' — ')[0] : piece);

// A host the title already names is not "hosting" it again: "Civic Tech Atlanta volunteers"
// under "Civic Tech Atlanta — Civic Action Night" adds nothing.
function repeatsTitle(host: string, title: string): boolean {
  const named = host.toLowerCase();
  const whole = title.toLowerCase();
  const organiser = whole.split(' — ')[0];
  return whole.includes(named) || named.includes(organiser) || organiser.includes(named);
}

function compose(parts: Parts, today: Date): EventEntry {
  const { title, when, area } = parts;
  const day = isEvergreen(`${title}. ${parts.whenText}`) ? null : inferWhen(`${title}. ${parts.whenText}`, today);

  // The part of town is already on the card's top line; the venue need not end with it.
  let venue = parts.venue.replace(/^(?:at|in)\s+/i, '').replace(/^(?:the|their|his|her)\s+/i, '');
  if (area && venue) venue = venue.replace(new RegExp(`,\\s*${escapeRegex(area)}(?:,?\\s+(?:GA|Georgia))?(?:\\s+\\d{5}(?:-\\d{4})?)?$`, 'i'), '');
  if (area && venue.toLowerCase() === area.toLowerCase()) venue = '';

  const lines = parts.lead.map((piece) => capitalize(brief(piece)));
  if (day) {
    const note = scheduleNote(when);
    if (note) lines.push(note);
  } else {
    // With no day to put it on, its wording is the only place the time is.
    lines.push(...when.map((piece) => capitalize(brief(piece))));
  }
  if (venue) lines.push(capitalize(venue));
  if (parts.host && !repeatsTitle(parts.host, title)) lines.push(`Hosted by ${parts.host}`);

  const extras = parts.extras
    .map(brief)
    .filter((extra) => extra.length >= MIN_EXTRA && extra.length <= MAX_EXTRA)
    .slice(0, MAX_EXTRAS)
    .map(capitalize);
  const optional = [...parts.warnings.slice(0, 1), ...extras];
  let detail = [...lines, ...optional].join(' · ');
  while (detail.length > MAX_DETAIL && optional.length > 0) {
    optional.pop();
    detail = [...lines, ...optional].join(' · ');
  }
  return { title, detail: clipWords(detail, MAX_DETAIL), when: day, area, cost: parts.cost, link: parts.link };
}

// The entries of one paragraph, or null when it has none (the older wording, one
// sentence per event, is read another way).
export function eventEntries(paragraph: string, today: Date): EventEntry[] | null {
  // "(1) **Name**" and "**(1) Name — dates**" number an entry the same way.
  const markdown = paragraph.replace(/\*\*\((\d{1,2})\)\s+/g, '($1) **');
  const marks = [...markdown.matchAll(ENTRY_MARK)];
  if (marks.length === 0) return null;
  const entries: EventEntry[] = [];
  marks.forEach((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = marks[index + 1]?.index ?? markdown.length;
    const entry = parseEntry(markdown.slice(start, end), today);
    if (entry) entries.push(entry);
  });
  return entries;
}

// ---- The labelled form ------------------------------------------------------------
//
//   **Survivalism:**
//
//   **(1) Georgia Bushcraft — Fall Gathering & Adventure Expo**
//   *America's premier outdoor adventure weekend ...*
//   - **When:** Fri Nov 6 – Sun Nov 8, 2026 · classes all weekend
//   - **Where:** 1150 Carruth Rd, Watkinsville GA 30677 — Watkinsville near Athens, ~1hr from home
//   - **Who:** Georgia Bushcraft (named instructors incl. Jason Salyer)
//   - **Price:** $156 weekend adult pass — 3-day admission + camping; youth $55, under-13 free
//   - **Type:** outdoor expo · survival classes · weekend camping
//   - **Link:** https://...
//
// Each labelled line already is the fact the card needs, so it is read as it is written
// rather than picked out of a sentence.

const ENTRY_HEAD = /^(?:\*\*\((\d{1,2})\)\s+(.+?)\*\*|\((\d{1,2})\)\s+\*\*(.+?)\*\*)\s*$/;
const LABEL_LINE = /^\*\*([^*]+?)(?::\*\*|\*\*:)\s*$/;
const FIELD_LINE = /^[-*+]\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/;
const ITALIC_LINE = /^\*[^*].*\*$/;

const cleanHost = (text: string) =>
  text
    .replace(/\s*\([^)]*\)/g, '')
    .split(/\s+with\s+/i)[0]
    .replace(/^(?:hosted by|the)\s+/i, '')
    .replace(/^all[- ]volunteer\s+/i, '')
    .trim();

// The parts of a line: "a · b, c" is three.
const partsOf = (text: string) => splitOutside(text.replace(/\s+·\s+/g, ', '), ',');

function fromFields(rawName: string, fields: Map<string, string>, today: Date): EventEntry | null {
  const title = clipWords(readable(rawName), MAX_TITLE);
  // A bold ending in a colon labels a remark about the options, not an event.
  if (title.length < 4 || /:\s*$/.test(title)) return null;
  const get = (...names: string[]) => names.map((name) => fields.get(name)).find((value) => value) ?? '';

  // When: "Mondays 1:30–4:30pm · Sep 14 – Nov 9 (9 weeks) ⚠️ daytime, conflicts with 9–5 — the only evening option"
  const warnings: string[] = [];
  let whenRaw = readable(get('when', 'day', 'date', 'time')).replace(ASIDE, '');
  const flagged = whenRaw.match(/^(.*?)\s*(?:[—–-]\s*)?⚠️?\s*(.*)$/);
  if (flagged) {
    const warning = warningOf(flagged[2]);
    if (warning) warnings.push(warning);
    whenRaw = flagged[1];
  }
  const [whenMain, ...remarks] = whenRaw.split(' — ');
  const type = readable(get('type', 'what', 'kind')).split(/\s+·\s+/)[0];

  // Where: "CAC Gallery Studio, 135 Chastain Park Ave NW — Buckhead, ~35min from home"
  const whereRaw = readable(get('where', 'location', 'venue')).replace(ASIDE, '').replace(LOCATION_NOTE, '');
  const { area } = extractAreaCost(whereRaw);

  // Who: "City of Atlanta Mayor's Office of Cultural Affairs · taught by Bryan Thompson",
  // "Byron Kerns (ex-Air Force SERE), 8 students max, adults 18+"
  const who = partsOf(readable(get('who', 'host', 'hosted by', 'organizer')).replace(ASIDE, ''));
  const named = who.filter((piece) => !STAFF_LEAD.test(piece) && !HOST_LEAD.test(piece));

  // Price: "$225–$425 by course · 50% deposit to reserve — (706) 318-8884"
  const priceRaw = readable(get('price', 'cost', 'fee', 'tickets'));
  const { cost } = extractAreaCost(priceRaw || `${whenRaw} ${whereRaw}`);

  const link = get('link', 'url', 'tickets link').match(URL)?.[0].replace(/[.,;:!?]+$/, '') ?? null;

  return compose(
    {
      title,
      lead: [type, ...remarks].filter((piece) => piece && piece.length <= MAX_EXTRA),
      // "last: Jul 30" says when it was, which is no help to anyone deciding to go
      when: partsOf(whenMain).filter((piece) => !/^last\b/i.test(piece)),
      whenText: whenRaw,
      venue: whereRaw.split(' — ')[0].trim(),
      host: cleanHost(named[0] ?? ''),
      warnings,
      extras: [...named.slice(1), ...priceRaw.split(/\s+·\s+/).slice(1)],
      area,
      cost,
      link,
    },
    today,
  );
}

export interface LabelledEntry {
  // The paragraph label ("Survivalism") it sat under; '' when it had none.
  label: string;
  entry: EventEntry;
}

// Pulls the labelled entries out of a section's lines; whatever is left over is
// returned to be read the older way.
export function labelledEntries(content: string, today: Date): { found: LabelledEntry[]; rest: string } {
  const found: LabelledEntry[] = [];
  const rest: string[] = [];
  let label = '';
  let block: { label: string; name: string; fields: Map<string, string> } | null = null as { label: string; name: string; fields: Map<string, string> } | null;
  const finish = () => {
    if (!block) return;
    const entry = fromFields(block.name, block.fields, today);
    if (entry) found.push({ label: block.label, entry });
    block = null;
  };
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const head = line.match(ENTRY_HEAD);
    if (head) {
      finish();
      block = { label, name: head[2] ?? head[4], fields: new Map() };
      continue;
    }
    const labelled = line.match(LABEL_LINE);
    if (labelled) {
      finish();
      label = labelled[1].trim();
      continue;
    }
    if (block) {
      if (!line) continue;
      const field = line.match(FIELD_LINE);
      if (field) {
        block.fields.set(field[1].trim().toLowerCase(), field[2].trim());
        continue;
      }
      // the one-line italic summary under the name
      if (ITALIC_LINE.test(line)) continue;
      finish();
    }
    rest.push(raw);
  }
  finish();
  return { found, rest: rest.join('\n') };
}
