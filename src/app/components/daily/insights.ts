import { stripInline } from './markdown';
import type { IrisFeedSection, IrisInsight } from './types';

// The insights feed under the Inana section: Iris's weekly review and Inana's
// audit broken into short posts, each tagged with what kind of thing it is. A
// finding and what to do about it are one post, never two.

export type PostKind = 'suggestion' | 'win' | 'drift' | 'insight' | 'opportunity' | 'decision';
export type PostAuthor = 'Iris' | 'Inana';

// What "Add to tasks" creates from a post.
export interface PostTask {
  title: string;
  category: string;
  when: string | null;
}

export interface Post {
  id: string;
  author: PostAuthor;
  kind: PostKind;
  // What changed or drifted, when the post pairs that with what to do about it.
  lead?: string;
  text: string;
  task?: PostTask;
}

// A post that says what to do.
export const isActionable = (post: Post) => Boolean(post.task) || post.kind === 'suggestion' || post.kind === 'opportunity' || post.kind === 'decision';

export const MAX_POST_LENGTH = 250;
// Inana's audit is written in long sentences; they are cut into bites this size.
const INANA_BITE = 180;
const MAX_PER_SECTION = 3;
const MAX_FROM_INANA = 4;
const MAX_POSTS = 14;
const MIN_LENGTH = 20;
// A second sentence only rides along when it is short and the whole still fits.
const MAX_FOLLOW_UP = 140;
const MAX_LEAD = 120;
const MAX_TASK_TITLE = 80;
// Two items are about the same thing when they share this many distinctive words.
const MIN_SHARED_WORDS = 2;

const IRIS_PARTS: { match: RegExp; kind: PostKind }[] = [
  { match: /\bwins?\b/i, kind: 'win' },
  { match: /\bdrift\b/i, kind: 'drift' },
  { match: /priorit/i, kind: 'suggestion' },
];
const INANA_PART = /inan+a|marketgenius/i;
// Tables, sources, event listings and the like are never posts.
const NEVER = /appendix|sources?|app health|date strategy|local activit|standing tracks?|question/i;
const SUGGESTS = /next recommended|recommended build|act on|should\b|worth\b/i;
// Words too common to say two items are about the same thing.
const COMMON = new Set(
  'this that with from have been were which their there than then them they what when will your week weeks still last next just only into back more most also some such once each over after about because through between being while where would could should since keeps done work pass open time days first second'.split(
    ' ',
  ),
);

// The items of one section: each list entry and each paragraph. Table rows and
// rules are skipped.
export function itemsOf(content: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) items.push(current.join(' '));
    current = [];
  };
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('|') || /^[-*_]{3,}$/.test(line)) {
      flush();
      continue;
    }
    const entry = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (entry) {
      flush();
      current.push(entry[1]);
    } else {
      current.push(line);
    }
  }
  flush();
  return items;
}

export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"“(])/);
}

// Cuts a too-long sentence: at its first aside ("lead — elaboration" reads fine
// as just "lead"), else at the last clause break or word inside the limit.
function clip(text: string, max: number): string {
  const dash = text.indexOf(' — ');
  if (dash >= 40 && dash <= max) return text.slice(0, dash).trim();
  const room = text.slice(0, max - 1);
  const breaks = [' — ', '; ', ': ', ', '].map((mark) => room.lastIndexOf(mark)).filter((at) => at >= max * 0.5);
  const at = breaks.length > 0 ? Math.max(...breaks) : room.lastIndexOf(' ');
  return `${room.slice(0, at > 0 ? at : room.length).replace(/[\s,;:—-]+$/, '')}…`;
}

export function plain(markdown: string): string {
  return stripInline(markdown)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();
}

// One item as a post: plain text, no links, the first sentence (Iris leads with
// the point in bold), plus the next one only if it is short and still fits.
export function shorten(markdown: string): string {
  const text = plain(markdown).replace(/^\([^)]{3,60}\)\s+/, '');
  const [first, ...rest] = sentencesOf(text);
  if (!first) return '';
  const lead = first.length > MAX_POST_LENGTH ? clip(first, MAX_POST_LENGTH) : first;
  const next = rest[0];
  if (lead === first && next && next.length <= MAX_FOLLOW_UP && lead.length + 1 + next.length <= MAX_POST_LENGTH) return `${lead} ${next}`;
  return lead;
}

// A long sentence as a few short ones: split at its asides (" — "), then at
// semicolons, then at " and ", merging neighbours back together while they fit.
function chunksOf(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  for (const separator of [' — ', '; ', ' and ']) {
    const parts = text.split(separator);
    if (parts.length < 2) continue;
    const chunks: string[] = [];
    let current = '';
    for (const part of parts) {
      const joined = current ? `${current}${separator}${part}` : part;
      if (!current || joined.length <= max) {
        current = joined;
      } else {
        chunks.push(current);
        current = part;
      }
    }
    if (current) chunks.push(current);
    if (chunks.length > 1) return chunks;
  }
  return [text];
}

// "and the prompt treats that as..." stands alone as "The prompt treats that as...".
function standalone(chunk: string): string {
  const text = chunk.replace(/^(?:and|but|so|then)\s+/i, '').trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…)"”]$/.test(sentence) ? sentence : `${sentence}.`;
}

// Inana's audit as bite-sized posts. The "From FILE.md (...):" provenance line
// is dropped; each sentence gives one bite, or two when its second half fits on
// its own.
function inanaPosts(section: IrisFeedSection): Post[] {
  const bites: string[] = [];
  for (const item of itemsOf(section.content)) {
    const text = plain(item).replace(/^From\s+\S+\.md\s*\([^)]*\):\s*/i, '');
    for (const sentence of sentencesOf(text)) {
      const [first, ...rest] = chunksOf(sentence, INANA_BITE);
      if (!first) continue;
      bites.push(standalone(first.length > MAX_POST_LENGTH ? clip(first, MAX_POST_LENGTH) : first));
      for (const chunk of rest.slice(0, 1)) if (chunk.length <= INANA_BITE) bites.push(standalone(chunk));
    }
  }
  const posts = bites
    .filter((text) => text.length >= MIN_LENGTH)
    .map<Post>((text, index) => ({ id: `inana-${index}`, author: 'Inana', kind: SUGGESTS.test(text) ? 'suggestion' : 'insight', text }));
  // What to do next survives the cap even though it comes last in the audit.
  return [...posts.filter((post) => post.kind === 'suggestion'), ...posts.filter((post) => post.kind !== 'suggestion')].slice(0, MAX_FROM_INANA);
}

function readable(text: string): boolean {
  return text.length >= MIN_LENGTH && !text.includes('|') && /[a-z]{3}/i.test(text);
}

// ---- Iris's own insights ---------------------------------------------------------

const INSIGHT_KINDS: PostKind[] = ['drift', 'opportunity', 'decision'];

function clipTitle(text: string): string {
  if (text.length <= MAX_TASK_TITLE) return text;
  const room = text.slice(0, MAX_TASK_TITLE - 1);
  return `${room.slice(0, Math.max(room.lastIndexOf(' '), 20)).replace(/[\s,;:—-]+$/, '')}…`;
}

// The weekly review writes each insight as one unit: what changed, what to do,
// and the task that "Add to tasks" creates as it is (iris-feed/TASKS-CONTRACT.md).
export function postsFromInsights(insights: IrisInsight[]): Post[] {
  return [...insights]
    .filter((insight) => insight.action.trim())
    .sort((a, b) => a.priority - b.priority)
    .map<Post>((insight, index) => {
      const action = insight.action.trim();
      return {
        id: `insight-${insight.id || index}`,
        author: 'Iris',
        kind: INSIGHT_KINDS.find((known) => known === insight.kind) ?? 'insight',
        lead: insight.observation.trim() || undefined,
        text: action,
        task: { title: insight.task?.title.trim() || clipTitle(action), category: insight.task?.category ?? '', when: insight.task?.when ?? null },
      };
    });
}

// ---- Pairing a finding with its action, until Iris writes them together --------

function keywords(text: string): Set<string> {
  return new Set(
    plain(text)
      .toLowerCase()
      .replace(/[’']s\b/g, '')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !COMMON.has(word)),
  );
}

function sharedWords(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

// "The book's hook work is still analysis-first, prose-second." as a lead line.
function observationOf(item: string): string {
  const text = plain(item);
  const first = sentencesOf(text)[0] ?? text;
  return first.length > MAX_LEAD ? clip(first, MAX_LEAD) : first;
}

// The task an action creates: its bold lead ("Write the book chapter revision,
// not more analysis"), without a "(Best social-connection action)" tag before it.
function taskTitleOf(item: string): string {
  const bold = item.match(/\*\*([^*]+)\*\*/)?.[1];
  const base = plain(bold ?? item).replace(/^\([^)]{3,60}\)\s*/, '');
  const first = (sentencesOf(base)[0] ?? base).replace(/[\s.:—-]+$/, '');
  return clipTitle(first);
}

// Each priority takes the drift it is about (the one sharing the most distinctive
// words with it), so "The book's hook work is still analysis-first" and "Write
// the book chapter revision, not more analysis" are one post. Drifts nothing
// answers stay as posts of their own.
function pairUp(drifts: string[], priorities: string[]): { actions: Post[]; unanswered: Post[] } {
  const driftWords = drifts.map(keywords);
  const taken = new Set<number>();
  const actions = priorities.map<Post>((item, index) => {
    const words = keywords(item);
    let best = -1;
    let bestScore = MIN_SHARED_WORDS - 1;
    driftWords.forEach((candidate, at) => {
      if (taken.has(at)) return;
      const shared = sharedWords(words, candidate);
      if (shared > bestScore) {
        best = at;
        bestScore = shared;
      }
    });
    const task: PostTask = { title: taskTitleOf(item), category: '', when: null };
    const text = shorten(item);
    if (best < 0) return { id: `iris-suggestion-${index}`, author: 'Iris', kind: 'suggestion', text, task };
    taken.add(best);
    return { id: `iris-paired-${index}`, author: 'Iris', kind: 'drift', lead: observationOf(drifts[best]), text, task };
  });
  const unanswered = drifts.flatMap<Post>((item, at) => (taken.has(at) ? [] : [{ id: `iris-drift-${at}`, author: 'Iris', kind: 'drift', text: shorten(item) }]));
  return { actions, unanswered };
}

// What to do comes first (Iris's, then Inana's), then what has slipped with
// nothing to do about it yet, then what was learned, then what went well.
export function buildPosts(sections: IrisFeedSection[], insights: IrisInsight[] = []): Post[] {
  const own = postsFromInsights(insights);
  const drifts: string[] = [];
  const priorities: string[] = [];
  const wins: Post[] = [];
  const inana: Post[] = [];

  const lane = (section: IrisFeedSection) =>
    itemsOf(section.content)
      .filter((item) => readable(shorten(item)))
      .slice(0, MAX_PER_SECTION);

  sections.forEach((section, position) => {
    if (INANA_PART.test(section.heading)) {
      inana.push(...inanaPosts(section));
      return;
    }
    if (NEVER.test(section.heading)) return;
    const part = IRIS_PARTS.find((entry) => entry.match.test(section.heading));
    if (!part) return;
    if (part.kind === 'win') wins.push(...lane(section).map<Post>((item, index) => ({ id: `iris-win${position}-${index}`, author: 'Iris', kind: 'win', text: shorten(item) })));
    else if (part.kind === 'drift') drifts.push(...lane(section));
    else priorities.push(...lane(section));
  });

  // Her own insights already say what the drifts and priorities of the review say.
  const { actions, unanswered } = own.length > 0 ? { actions: own, unanswered: [] as Post[] } : pairUp(drifts, priorities);

  // If the review's headings change, fall back to whatever readable parts it has.
  const spare: Post[] = [];
  if (own.length === 0 && wins.length + drifts.length + priorities.length === 0) {
    sections.forEach((section, position) => {
      if (INANA_PART.test(section.heading) || NEVER.test(section.heading)) return;
      spare.push(...lane(section).map<Post>((item, index) => ({ id: `iris-part${position}-${index}`, author: 'Iris', kind: 'insight', text: shorten(item) })));
    });
  }

  const seen = new Set<string>();
  return [...actions, ...inana.filter((post) => post.kind === 'suggestion'), ...unanswered, ...spare, ...inana.filter((post) => post.kind !== 'suggestion'), ...wins]
    .filter((post) => (seen.has(post.text) ? false : (seen.add(post.text), true)))
    .slice(0, MAX_POSTS);
}
