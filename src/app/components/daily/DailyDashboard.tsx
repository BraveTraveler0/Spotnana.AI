import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion } from 'motion/react';
import { RefreshCw } from 'lucide-react';
import GoalsWidget from './GoalsWidget';
import { InanaInsight, InanaKpis } from './InanaPanels';
import { scopeOptions } from './inana';
import HiddenSections from './HiddenSections';
import InsightFeed from './InsightFeed';
import { buildPosts, type Post } from './insights';
import LocationPicker from './LocationPicker';
import { CATEGORY_TOPIC, TOPICS } from './newsTopics';
import { HideButton, NewsBlockBody, TopStory, type NewsBlockData, type NewsBlockStyle } from './NewsPanels';
import TasksPanel from './TasksPanel';
import TasteStrip from './TasteStrip';
import { REVIEW_PREFIX, reviewSuggestions } from './reviewSuggestions';
import { recentlyFinished, withoutFinished } from './finished';
import { cardKey, useFinishedCards, useHandledCards, useScoutRequest } from './useIrisCards';
import { useHandledPosts, postKey } from './useHandledPosts';
import { useGoalTaps } from './useGoalTaps';
import { useHiddenTopics } from './useHiddenTopics';
import { useInana } from './useInana';
import { isAndroid, usePhoneFeed } from './usePhoneFeed';
import WeatherGlyph from './WeatherGlyph';
import type { DailyTask, GoalSection, GoalSubStep, IrisFeedContent, IrisTaskCard, LocationInfo, NewsItem, ScheduledTaskInfo, TasteRec, WeatherInfo, WeeklyGoals } from './types';
import './daily.css';

interface Props {
  isTauri: boolean;
  // The dashboard stays mounted once opened so weather, headlines and charts
  // aren't refetched on every tab switch; this says whether it's on screen.
  active: boolean;
  onOpenGoals: () => void;
  onOpenSettings: () => void;
  // Drops a ready-to-send prompt about a goal into the chat box; never sends it.
  onStartGoalSession: (prompt: string) => void;
  // Bumped by the app when Inana is connected or disconnected in Settings.
  inanaVersion: number;
  // Bumped when the saved weather location changes in Settings.
  locationVersion: number;
}

// How long an accepted suggestion keeps showing in Next while waiting on Iris.
const PENDING_ACCEPT_MS = 2 * 24 * 60 * 60 * 1000;

const SCOPE_STORAGE_KEY = 'artemis-inana-scope';
const FEED_STALE_MS = 30 * 60 * 1000;

// A small, verified set — each is a real line with its author and work, never
// a paraphrase dressed up as a quote. Iris's own daily spark replaces this
// whenever her feed has one.
const QUOTES = [
  // Shakespeare — long, beautiful lines given priority by appearing first
  { text: 'We are such stuff as dreams are made on, and our little life is rounded with a sleep.', by: 'William Shakespeare', work: 'The Tempest' },
  { text: 'The earth has music for those who listen, and heaven finds a tongue in everything that grows.', by: 'William Shakespeare', work: 'The Taming of the Shrew' },
  { text: 'Love all, trust a few, do wrong to none; be able for thine enemy rather in power than use, and keep thy friend under thy own life\'s key.', by: 'William Shakespeare', work: "All's Well That Ends Well" },
  { text: 'Our doubts are traitors, and make us lose the good we oft might win, by fearing to attempt.', by: 'William Shakespeare', work: 'Measure for Measure' },
  { text: 'What a piece of work is a man, how noble in reason, how infinite in faculty, in form and moving how express and admirable, in action how like an angel, in apprehension how like a god!', by: 'William Shakespeare', work: 'Hamlet' },
  { text: 'This above all: to thine own self be true, and it must follow, as the night the day, thou canst not then be false to any man.', by: 'William Shakespeare', work: 'Hamlet' },
  { text: 'There is a tide in the affairs of men which, taken at the flood, leads on to fortune; omitted, all the voyage of their life is bound in shallows and in miseries.', by: 'William Shakespeare', work: 'Julius Caesar' },
  { text: 'Be not afraid of greatness: some are born great, some achieve greatness, and some have greatness thrust upon them.', by: 'William Shakespeare', work: 'Twelfth Night' },
  { text: 'The robbed that smiles, steals something from the thief; he robs himself that spends a bootless grief.', by: 'William Shakespeare', work: 'Othello' },
  { text: 'How far that little candle throws his beams! So shines a good deed in a naughty world.', by: 'William Shakespeare', work: 'The Merchant of Venice' },
  { text: 'Go wisely and slowly. Those who rush stumble and fall.', by: 'William Shakespeare', work: 'Romeo and Juliet' },
  { text: 'Cowards die many times before their deaths; the valiant never taste of death but once.', by: 'William Shakespeare', work: 'Julius Caesar' },
  { text: 'My bounty is as boundless as the sea, my love as deep; the more I give to thee, the more I have, for both are infinite.', by: 'William Shakespeare', work: 'Romeo and Juliet' },
  { text: 'Though she be but little, she is fierce.', by: 'William Shakespeare', work: "A Midsummer Night's Dream" },
  { text: 'When sorrows come, they come not single spies, but in battalions.', by: 'William Shakespeare', work: 'Hamlet' },
  { text: 'Let me not to the marriage of true minds admit impediments. Love is not love which alters when it alteration finds, or bends with the remover to remove.', by: 'William Shakespeare', work: 'Sonnet 116' },
  { text: 'Like as the waves make towards the pebbled shore, so do our minutes hasten to their end, each changing place with that which goes before, in sequent toil all forwards do contend.', by: 'William Shakespeare', work: 'Sonnet 60' },
  { text: 'The quality of mercy is not strained; it droppeth as the gentle rain from heaven upon the place beneath. It is twice blest: it blesseth him that gives and him that takes.', by: 'William Shakespeare', work: 'The Merchant of Venice' },
  { text: 'All the world\'s a stage, and all the men and women merely players; they have their exits and their entrances, and one man in his time plays many parts.', by: 'William Shakespeare', work: 'As You Like It' },
  { text: 'If music be the food of love, play on, give me excess of it; that surfeiting, the appetite may sicken, and so die.', by: 'William Shakespeare', work: 'Twelfth Night' },
  { text: 'Shall I compare thee to a summer\'s day? Thou art more lovely and more temperate. Rough winds do shake the darling buds of May, and summer\'s lease hath all too short a date.', by: 'William Shakespeare', work: 'Sonnet 18' },
  { text: 'No longer mourn for me when I am dead than you shall hear the surly sullen bell give warning to the world that I am fled from this vile world, with vilest worms to dwell.', by: 'William Shakespeare', work: 'Sonnet 71' },
  // Other authors
  { text: "The struggle itself toward the heights is enough to fill a man's heart. One must imagine Sisyphus happy.", by: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'Not everything that is faced can be changed, but nothing can be changed until it is faced.', by: 'James Baldwin', work: '"As Much Truth as One Can Bear," The New York Times Book Review, 1962' },
  { text: 'The world breaks everyone and afterward many are strong at the broken places.', by: 'Ernest Hemingway', work: 'A Farewell to Arms' },
  { text: 'We are all in the gutter, but some of us are looking at the stars.', by: 'Oscar Wilde', work: "Lady Windermere's Fan" },
  { text: 'There is no fate that cannot be surmounted by scorn.', by: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'A man can be destroyed but not defeated.', by: 'Ernest Hemingway', work: 'The Old Man and the Sea' },
  { text: 'The only way to make sense of change is to plunge into it, move with it, and join the dance.', by: 'Alan Watts', work: 'The Wisdom of Insecurity' },
  { text: 'He who has a why to live can bear almost any how.', by: 'Viktor Frankl', work: "Man's Search for Meaning" },
  { text: 'The soul becomes dyed with the color of its thoughts.', by: 'Marcus Aurelius', work: 'Meditations' },
  { text: 'We suffer more in imagination than in reality.', by: 'Seneca', work: 'Moral Letters to Lucilius' },
  { text: 'Life is not a problem to be solved, but a reality to be experienced.', by: 'Søren Kierkegaard', work: 'Journal, 1843' },
  { text: 'The purpose of life is not to be happy. It is to be useful, to be honorable, to be compassionate.', by: 'Ralph Waldo Emerson', work: 'Essays: First Series' },
  { text: 'Man is not fully conditioned and determined but he determines himself whether he gives in to conditions or stands up to them.', by: 'Viktor Frankl', work: "Man's Search for Meaning" },
  { text: 'The only real voyage of discovery consists not in seeking new landscapes, but in having new eyes.', by: 'Marcel Proust', work: 'In Search of Lost Time' },
];

// Cached quotes from Horus (fetched via Tauri command)
interface CachedQuote { text: string; by: string; work: string; }

function dayOfYear(date: Date): number {
  return Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000);
}

function Reveal({ delay = 0, className, children }: { delay?: number; className?: string; children: ReactNode }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay, ease: 'easeOut' }}>
      {children}
    </motion.div>
  );
}

// ---- The right column's news blocks ---------------------------------------------------
// Each block is one category in one style, so the column reads like a page of a
// magazine rather than one long list. Blocks are filled in this order from the
// stories that really have a working picture; a block that can't be filled is
// skipped. The column then shows as many as it takes to run at least as long as
// the middle column.
interface BlockSpec {
  style: NewsBlockStyle;
  // The hideable topic this block belongs to (see newsTopics.ts).
  topic: string;
  label: string;
  categories: string[];
  count: number;
  min: number;
}

const NEWS_BLOCK_SPECS: BlockSpec[] = [
  { style: 'feature', topic: 'technology', label: 'Technology', categories: ['Technology'], count: 1, min: 1 },
  { style: 'rows', topic: 'world', label: 'Politics & World', categories: ['Politics', 'World'], count: 3, min: 2 },
  { style: 'rows', topic: 'local', label: 'Local News', categories: [], count: 4, min: 1 },
  { style: 'trailer', topic: 'trailers', label: 'Movie Trailer', categories: [], count: 1, min: 1 },
  { style: 'grid', topic: 'art', label: 'Art', categories: ['Art'], count: 2, min: 2 },
  { style: 'compact', topic: 'science', label: 'Science', categories: ['Science'], count: 4, min: 2 },
  { style: 'tall', topic: 'ideas', label: 'Ideas', categories: ['Ideas'], count: 1, min: 1 },
   { style: 'rows', topic: 'essays', label: 'Aeon Essays', categories: ['Essays'], count: 3, min: 2 },
   { style: 'compact', topic: 'morning', label: 'Morning Brief', categories: ['Morning Brief'], count: 3, min: 2 },
   { style: 'compact', topic: 'ideas', label: 'Ideas', categories: ['Ideas'], count: 3, min: 2 },
  { style: 'rows', topic: 'books', label: 'Books', categories: ['Books'], count: 3, min: 2 },
  { style: 'feature', topic: 'film', label: 'Film', categories: ['Film'], count: 1, min: 1 },
  { style: 'grid', topic: 'history', label: 'History & Culture', categories: ['History', 'Culture'], count: 4, min: 2 },
  { style: 'wide', topic: 'art', label: 'Art', categories: ['Art'], count: 1, min: 1 },
  { style: 'compact', topic: 'outdoors', label: 'The Outdoors', categories: ['Outdoors'], count: 4, min: 2 },
  { style: 'rows', topic: 'technology', label: 'Technology', categories: ['Technology'], count: 3, min: 2 },
  { style: 'compact', topic: 'film', label: 'Film', categories: ['Film'], count: 4, min: 2 },
  { style: 'grid', topic: 'world', label: 'World', categories: ['World'], count: 2, min: 2 },
  { style: 'tall', topic: 'books', label: 'Books', categories: ['Books'], count: 1, min: 1 },
];

// Round-robins across sources, so a block of two Art stories is one from
// Colossal and one from Hyperallergic rather than two from the same feed.
function interleaveBySource(items: NewsItem[]): NewsItem[] {
  const queues = new Map<string, NewsItem[]>();
  for (const item of items) {
    const queue = queues.get(item.source) ?? [];
    queue.push(item);
    queues.set(item.source, queue);
  }
  const lists = [...queues.values()];
  const ordered: NewsItem[] = [];
  for (let round = 0; ordered.length < items.length; round++) {
    for (const list of lists) {
      if (round < list.length) ordered.push(list[round]);
    }
  }
  return ordered;
}

function buildNewsBlocks(pool: NewsItem[], trailers: NewsItem[], local: NewsItem[], reserved: NewsItem[], hidden: Set<string>): NewsBlockData[] {
  const used = new Set(reserved.map((item) => item.link));
  const blocks: NewsBlockData[] = [];
  NEWS_BLOCK_SPECS.forEach((spec, index) => {
    // A hidden topic takes no stories, so the column fills with the ones still shown.
    if (hidden.has(spec.topic)) return;
    const candidates = spec.style === 'trailer' ? trailers : spec.topic === 'local' ? interleaveBySource(local) : interleaveBySource(pool.filter((item) => spec.categories.includes(item.category)));
    const items = candidates.filter((item) => !used.has(item.link)).slice(0, spec.count);
    if (items.length < spec.min) return;
    items.forEach((item) => used.add(item.link));
    blocks.push({ key: `${spec.style}-${index}`, style: spec.style, topic: spec.topic, label: spec.label, items });
  });
  return blocks;
}

export default function DailyDashboard({ isTauri, active, onOpenGoals, onOpenSettings, onStartGoalSession, inanaVersion, locationVersion }: Props) {
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [weatherError, setWeatherError] = useState('');
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [newsError, setNewsError] = useState('');
  const [trailers, setTrailers] = useState<NewsItem[] | null>(null);
  const [localNews, setLocalNews] = useState<NewsItem[] | null>(null);
  const { hidden, hide, show, showAll } = useHiddenTopics();
  const [tasks, setTasks] = useState<DailyTask[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTaskInfo[]>([]);
  const [goals, setGoals] = useState<GoalSection[]>([]);
  const [goalsError, setGoalsError] = useState('');
  const [goalsLoaded, setGoalsLoaded] = useState(false);
  const [breakingDown, setBreakingDown] = useState<Set<string>>(new Set());
  const [irisFeed, setIrisFeed] = useState<IrisFeedContent | null>(null);
  const [weekly, setWeekly] = useState<WeeklyGoals | null>(null);
  const goalTaps = useGoalTaps(weekly);
  const [suggestionAnswered, setSuggestionAnswered] = useState(false);
  const [suggestionResponding, setSuggestionResponding] = useState(false);
  const { handled, dismiss: dismissCard, markAccepted } = useHandledCards();
  const { finished, finish: finishCard, undo: undoFinished } = useFinishedCards();
  const { choices: postChoices, choose: choosePost, restore: restorePosts } = useHandledPosts();
  const scout = useScoutRequest();
  const [accepting, setAccepting] = useState<Set<string>>(new Set());
  const [cardNotice, setCardNotice] = useState('');
  const [scope, setScope] = useState(() => {
    try {
      return localStorage.getItem(SCOPE_STORAGE_KEY) || 'all';
    } catch {
      return 'all';
    }
  });

  // Pictures that failed to load or turned out to be a beacon or logo. The
  // stories they belong to are dropped and replaced from the pool.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const reportBroken = useCallback((image: string) => {
    setBrokenImages((previous) => (previous.has(image) ? previous : new Set(previous).add(image)));
  }, []);
  const [shownBlocks, setShownBlocks] = useState(4);
    const [, setLayoutTick] = useState(0);

    // Quote pool: merges hardcoded QUOTES with cached quotes from Horus.
    // The daily quote picks from this combined pool using dayOfYear for consistency,
    // but a manual refresh cycles to the next quote immediately.
    const [cachedQuotes, setCachedQuotes] = useState<CachedQuote[]>([]);
    const [quoteIndex, setQuoteIndex] = useState(0);
    const [quoteLoading, setQuoteLoading] = useState(false);

    const allQuotes = useMemo(() => {
      const merged = [...QUOTES, ...cachedQuotes];
      // Deduplicate by text
      const seen = new Set<string>();
      return merged.filter((q) => {
        const key = q.text.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }, [cachedQuotes]);

    // Fetch cached quotes from Horus on mount (and when dashboard becomes active)
    useEffect(() => {
      if (!isTauri || !active) return;
      let mounted = true;
      setQuoteLoading(true);
      const timeoutPromise = new Promise<unknown>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout fetching quotes')), 5000);
      });
      Promise.race([invoke<CachedQuote[]>('fetch_daily_quotes'), timeoutPromise])
        .then((quotes) => {
          if (mounted && quotes.length > 0) setCachedQuotes(quotes);
        })
        .catch((err) => {
          console.error(err);
        })
        .finally(() => { if (mounted) setQuoteLoading(false); });
      return () => { mounted = false; };
    }, [isTauri, active]);

    // Background refresh of quotes during non-morning hours (after 10am, before 10pm)
    // Horus is slow, so we only do this when it won't block the morning dashboard load.
    useEffect(() => {
      if (!isTauri || !active) return;
      const hour = new Date().getHours();
      if (hour < 10 || hour >= 22) return; // morning (before 10am) or late night — skip
      const timer = setTimeout(() => {
        invoke<CachedQuote[]>('fetch_daily_quotes')
          .then((quotes) => { if (quotes.length > 0) setCachedQuotes(quotes); })
          .catch(console.error);
      }, 5000); // small delay so dashboard renders first
      return () => clearTimeout(timer);
    }, [isTauri, active]);

    const middleRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  // Left column parity: the agenda's cap starts at the stylesheet default and
  // grows only while the left column is shorter than the middle one, so the
  // three columns read as one page instead of the left stopping early.
  const [agendaMaxHeight, setAgendaMaxHeight] = useState<number | null>(null);
  const agendaListRef = useRef<HTMLUListElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);

  // MarketGenius runs on the PC, so on a phone there is nothing to ask and no Inana panels.
  const inana = useInana(isTauri && active && !isAndroid, inanaVersion);
  // On the phone the feed is a copy brought over Tailscale; a new copy re-reads it at once.
  const [feedVersion, setFeedVersion] = useState(0);
  const reloadFeed = useCallback(() => setFeedVersion((version) => version + 1), []);
  const phoneFeed = usePhoneFeed(isTauri && active, reloadFeed);
  const loadedAt = useRef({ weather: 0, news: 0, trailers: 0 });
  const isStale = (key: 'weather' | 'news' | 'trailers') => Date.now() - loadedAt.current[key] > FEED_STALE_MS;

  const openLink = useCallback(
    (url: string) => {
      if (isTauri) invoke('open_external_url', { url }).catch(console.error);
      else window.open(url, '_blank', 'noopener');
    },
    [isTauri],
  );

  const loadWeather = useCallback(() => {
    loadedAt.current.weather = Date.now();
    invoke<WeatherInfo>('fetch_daily_weather')
      .then((result) => {
        setWeather(result);
        setWeatherError('');
      })
      .catch((err) => setWeatherError(String(err)));
    invoke<LocationInfo>('get_location').then(setLocation).catch(console.error);
    // Local news follows the place too, so it reloads whenever the weather does.
    invoke<NewsItem[]>('fetch_local_news').then(setLocalNews).catch(() => setLocalNews([]));
  }, []);

  // Dominus's refresh button: re-runs every loader the dashboard has, ignoring
  // the staleness gates so what's on screen is always the newest the sources have.
  const [refreshing, setRefreshing] = useState(false);
  const refreshInana = inana.refresh;
  const syncPhoneFeed = phoneFeed.sync;
  const refreshAll = useCallback(() => {
    setRefreshing(true);
    loadedAt.current.weather = 0;
    loadedAt.current.news = 0;
    loadedAt.current.trailers = 0;
    setFeedVersion((version) => version + 1);
    // On the phone this also brings over a fresh copy of Iris's files; off it, nothing happens.
    void syncPhoneFeed(true);
    if (isTauri) {
      loadWeather();
      invoke<NewsItem[]>('fetch_daily_news').then((items) => { setNews(items); setNewsError(''); }).catch(() => {});
      invoke<NewsItem[]>('fetch_movie_trailers').then(setTrailers).catch(() => {});
      invoke<DailyTask[]>('list_todos').then(setTasks).catch(() => {});
      invoke<ScheduledTaskInfo[]>('list_scheduled_tasks_direct').then(setScheduled).catch(() => {});
      invoke<GoalSection[]>('get_goals').then((sections) => { setGoals(sections); setGoalsError(''); }).catch(() => {});
      invoke<WeeklyGoals>('get_weekly_goals').then((next) => setWeekly((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))).catch(() => {});
    }
    // Inana is a stable callback that does nothing when its panels are off (the phone).
    void refreshInana();
    // release the spinner on the next tick after the state updates land
    setTimeout(() => setRefreshing(false), 900);
  }, [isTauri, loadWeather, refreshInana, syncPhoneFeed]);

  // Tasks and goals are cheap local reads and can change from the Chat and
  // Goals tabs, so they refresh on every visit; weather and headlines only when
  // stale.
  useEffect(() => {
    if (!isTauri || !active) return;

    if (isStale('weather')) loadWeather();
    if (isStale('news')) {
      loadedAt.current.news = Date.now();
      invoke<NewsItem[]>('fetch_daily_news')
        .then((items) => {
          setNews(items);
          setNewsError('');
        })
        .catch((err) => setNewsError(String(err)));
    }
    if (isStale('trailers')) {
      loadedAt.current.trailers = Date.now();
      invoke<NewsItem[]>('fetch_movie_trailers').then(setTrailers).catch(() => setTrailers([]));
    }

    invoke<DailyTask[]>('list_todos').then(setTasks).catch(console.error);
    invoke<ScheduledTaskInfo[]>('list_scheduled_tasks_direct').then(setScheduled).catch(console.error);
    invoke<GoalSection[]>('get_goals')
      .then((sections) => {
        setGoals(sections);
        setGoalsError('');
      })
      .catch((err) => setGoalsError(String(err)))
      .finally(() => setGoalsLoaded(true));
  }, [isTauri, active, loadWeather]);

  // A location picked in Settings while this is hidden still refreshes the weather.
  const initialLocationVersion = useRef(locationVersion);
  useEffect(() => {
    if (!isTauri || locationVersion === initialLocationVersion.current) return;
    setWeather(null);
    setLocalNews(null);
    loadWeather();
  }, [isTauri, locationVersion, loadWeather]);

  // Polls only while visible: Iris updates these at most a few times a day.
  useEffect(() => {
    if (!isTauri || !active) return;
    const fetchWeekly = () => {
      invoke<WeeklyGoals>('get_weekly_goals')
        .then((next) => setWeekly((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next)))
        .catch(console.error);
    };
    const fetchFeed = () => {
      fetchWeekly();
      invoke<IrisFeedContent>('get_iris_feed')
        .then((feed) => {
          setIrisFeed((previous) => {
            if (previous && previous.updated !== feed.updated) setSuggestionAnswered(false);
            // tasks.updated gates the redraw: an unchanged feed keeps the same
            // object, so nothing below re-renders every minute for no reason.
            if (previous && previous.updated === feed.updated && previous.tasks.updated === feed.tasks.updated) return previous;
            return feed;
          });
        })
        .catch(console.error);
    };
    fetchFeed();
    const interval = setInterval(fetchFeed, 60000);
    return () => clearInterval(interval);
  }, [isTauri, active, feedVersion]);

  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, scope);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
  }, [scope]);

  // A new sign-in may be a different account, so it shouldn't inherit the last
  // one's product filter.
  const initialInanaVersion = useRef(inanaVersion);
  useEffect(() => {
    if (inanaVersion !== initialInanaVersion.current) setScope('all');
  }, [inanaVersion]);

  // A saved product can disappear from Inana; fall back to everything rather
  // than showing an empty scope forever.
  useEffect(() => {
    if (inana.data && scope !== 'all' && !scopeOptions(inana.data).some((product) => product.id === scope)) setScope('all');
  }, [inana.data, scope]);

  // ---- Tasks ----------------------------------------------------------------

  const addTask = async ({ label, source, note, when, area, cost }: { label: string; source?: string; note?: string; when?: string | null; area?: string | null; cost?: string | null }) => {
    try {
      const task = await invoke<DailyTask>('add_todo', { label, source: source ?? null, note: note ?? null, when: when ?? null, area: area ?? null, cost: cost ?? null });
      setTasks((previous) => (previous.some((t) => t.id === task.id) ? previous : [...previous, task]));
      return true;
    } catch (err) {
      console.error(err);
      // Say so: a task that silently doesn't appear looks like a button that does nothing.
      setCardNotice("Couldn't save that task. Try again.");
      return false;
    }
  };

  const toggleTask = async (id: string, currentlyDone: boolean) => {
    setTasks((previous) => previous.map((task) => (task.id === id ? { ...task, done: !currentlyDone } : task)));
    try {
      await invoke('set_todo_done', { id, done: !currentlyDone });
    } catch (err) {
      console.error(err);
      setTasks((previous) => previous.map((task) => (task.id === id ? { ...task, done: currentlyDone } : task)));
    }
  };

  const removeTask = async (id: string) => {
    setTasks((previous) => previous.filter((task) => task.id !== id));
    try {
      await invoke('remove_todo', { id });
    } catch (err) {
      console.error(err);
    }
  };

  const cancelScheduled = async (id: string) => {
    setScheduled((previous) => previous.filter((task) => task.id !== id));
    try {
      await invoke('cancel_scheduled_task_by_id', { id });
    } catch (err) {
      console.error(err);
    }
  };

  // ---- Goals ----------------------------------------------------------------

  const toggleGoal = async (itemId: string, currentlyDone: boolean) => {
    const apply = (done: boolean) =>
      setGoals((previous) => previous.map((section) => ({ ...section, items: section.items.map((item) => (item.id === itemId ? { ...item, done } : item)) })));
    apply(!currentlyDone);
    try {
      await invoke('toggle_goal_item', { id: itemId, done: !currentlyDone });
    } catch (err) {
      console.error(err);
      apply(currentlyDone);
    }
  };

  const breakDownGoal = async (sectionTitle: string, itemId: string, itemText: string) => {
    if (breakingDown.has(itemId)) return;
    setBreakingDown((previous) => new Set(previous).add(itemId));
    try {
      const subSteps = await invoke<GoalSubStep[]>('break_down_goal', { sectionTitle, itemId, itemText });
      setGoals((previous) => previous.map((section) => ({ ...section, items: section.items.map((item) => (item.id === itemId ? { ...item, sub_steps: subSteps } : item)) })));
    } catch (err) {
      console.error(err);
    } finally {
      setBreakingDown((previous) => {
        const next = new Set(previous);
        next.delete(itemId);
        return next;
      });
    }
  };

  const answerSuggestion = async (answer: 'yes' | 'no') => {
    if (!irisFeed?.suggestion_text || suggestionResponding) return;
    setSuggestionResponding(true);
    try {
      await invoke('respond_to_iris_suggestion', { suggestionText: irisFeed.suggestion_text, answer });
      setSuggestionAnswered(true);
    } catch (err) {
      console.error(err);
    } finally {
      setSuggestionResponding(false);
    }
  };

  // ---- Derived content --------------------------------------------------------

  const feedTasks = irisFeed?.tasks;
  // When Iris last wrote the cards: any count on them ("0 of 2 done") is as of then.
  const cardsWrittenAt = Date.parse(feedTasks?.updated || irisFeed?.updated || '') || 0;
  // Minus what was dismissed, accepted or checked off. A weekly minimum stays,
  // with its count moved up, until the week's target is met.
  const nextCards = useMemo(
    () => withoutFinished((feedTasks?.next ?? []).filter((card) => !handled[cardKey(card)]), finished, cardsWrittenAt),
    [feedTasks, handled, finished, cardsWrittenAt],
  );
  const finishedCards = useMemo(() => recentlyFinished(finished), [finished]);
  // Iris's own suggestions, then the things her weekly review lists to do (local
  // activities, standing tracks) until she writes those into the feed herself.
  const reviewCards = useMemo(() => reviewSuggestions(irisFeed?.review_sections ?? []), [irisFeed]);
  // A recurring weekly goal (Writing session, Yoga, Meditation...) already has its own
  // progress ring and rows on the Goals widget; echoing it again as a "Suggested" card
  // is just noise, not a new idea. Anything with a goal_id, or whose title matches a
  // current weekly goal by name, is filtered out here so Suggested only ever holds
  // things you aren't already tracking.
  const weeklyGoalTitles = useMemo(() => new Set((weekly?.goals ?? []).map((goal) => goal.title.trim().toLowerCase())), [weekly]);
  const isWeeklyGoalEcho = useCallback(
    (card: IrisTaskCard) => Boolean(card.goal_id) || weeklyGoalTitles.has(card.title.trim().toLowerCase()),
    [weeklyGoalTitles],
  );
  const suggestedCards = useMemo(() => {
    const own = (feedTasks?.suggested ?? []).filter((card) => !isWeeklyGoalEcho(card));
    const known = new Set(own.map((card) => card.title.trim().toLowerCase()));
    return [...own, ...reviewCards.filter((card) => !known.has(card.title.trim().toLowerCase()) && !isWeeklyGoalEcho(card))].filter((card) => !handled[cardKey(card)]);
  }, [feedTasks, reviewCards, handled, isWeeklyGoalEcho]);

  // Accepted cards wait in Next until Iris has rewritten the feed with her own
  // Next card for them (matched by title), or two days pass.
  const pendingCards = useMemo(() => {
    const scheduledTitles = new Set((feedTasks?.next ?? []).map((card) => card.title.trim().toLowerCase()));
    const cutoff = Date.now() - PENDING_ACCEPT_MS;
    const waiting = Object.values(handled)
      .filter((entry) => entry.kind === 'accepted' && entry.at > cutoff && !scheduledTitles.has(entry.card.title.trim().toLowerCase()))
      .map((entry) => entry.card);
    return withoutFinished(waiting, finished, cardsWrittenAt);
  }, [feedTasks, handled, finished, cardsWrittenAt]);

  const acceptCard = async (card: IrisTaskCard) => {
    if (card.id.startsWith(REVIEW_PREFIX)) {
      // Iris has never heard of these ids, so there is nothing to tell her:
      // taking one on just puts it on your own list, on the day and time the
      // review's wording gave it (none for a weekly lesson: that waits under Anytime).
      await addTask({ label: card.title, note: card.detail, source: 'Iris', when: card.when, area: card.area, cost: card.cost });
      dismissCard(card);
      return;
    }
    const key = cardKey(card);
    if (accepting.has(key)) return;
    setCardNotice('');
    setAccepting((previous) => new Set(previous).add(key));
    try {
      await invoke('accept_iris_task', { id: card.id });
      markAccepted(card);
    } catch (err) {
      setCardNotice(String(err));
    } finally {
      setAccepting((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  };

  // Checking off a card takes it out of Next at once. One that counts toward a
  // weekly goal is a completion Iris has to record (she keeps the count), so a
  // line goes to her check-off file; the card is checked off here either way.
  const completeCard = async (card: IrisTaskCard) => {
    setCardNotice('');
    finishCard(card);
    if (!card.goal_id) return;
    try {
      await invoke('record_checkoff', { goalId: card.goal_id });
      // The Goals ring counts it too (when the card's goal is one of the ring's).
      goalTaps.recorded(card.goal_id);
      // On the phone the line waits in a queue until it can go to Iris over Tailscale; try now.
      void phoneFeed.sync(true);
    } catch (err) {
      setCardNotice(`Checked off here, but Iris wasn't told: ${String(err)}`);
    }
  };

  // Taking a rec ("worth a taste") onto your list saves it like any task: the
  // name on the line, the hook as its note, the part of town as its area. The
  // recipe kind reads as "To cook" on the card, so say that on the task too.
  const addRec = async (rec: TasteRec): Promise<boolean> =>
    addTask({
      label: rec.kind === 'recipe' ? `Cook ${rec.name}` : rec.name,
      note: rec.note,
      source: 'Worth a taste',
      area: rec.area,
    });

  // Her insights replace the older one-line suggestion (TASKS-CONTRACT.md: "read
  // insights instead"). While both are in the feed they are the same thought said
  // twice, so only the insight shows.
  const hasInsights = (irisFeed?.insights?.length ?? 0) > 0;
  const irisSuggestion = irisFeed?.suggestion_text && !hasInsights
    ? { text: irisFeed.suggestion_text, needsAnswer: irisFeed.suggestion_needs_answer, answered: suggestionAnswered, responding: suggestionResponding }
    : null;

  // A story only counts if its picture is real: present, not a known-broken
  // one, and not a duplicate of a story already in the pool.
  const usable = (items: NewsItem[] | null) => {
    const seen = new Set<string>();
    return (items ?? []).filter((item) => {
      if (!item.image || brokenImages.has(item.image) || seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });
  };
  const newsPool = useMemo(() => usable(news), [news, brokenImages]);
  const trailerPool = useMemo(() => usable(trailers), [trailers, brokenImages]);
  // Local stories sit in the sidebar with the rest of the news.
  const localPool = useMemo(() => usable(localNews), [localNews, brokenImages]);

  // The big slot takes the sharpest picture among the world and politics stories,
  // unless that topic is hidden: then it picks from what is still shown, so hiding
  // Politics & World means no headline of that kind leads the page either.
  const topStory = useMemo(() => {
    const shown = newsPool.filter((item) => !hidden.has(CATEGORY_TOPIC[item.category] ?? ''));
    const headlines = shown.filter((item) => item.category === 'World' || item.category === 'Politics');
    const candidates = headlines.length > 0 ? headlines : shown;
    return candidates.reduce<NewsItem | undefined>((best, item) => (!best || (item.image_width ?? 0) > (best.image_width ?? 0) ? item : best), undefined);
  }, [newsPool, hidden]);

  const newsBlocks = useMemo(
    () => buildNewsBlocks(newsPool, trailerPool, localPool, topStory && !hidden.has('top') ? [topStory] : [], hidden),
    [newsPool, trailerPool, localPool, topStory, hidden],
  );
  // In the order the topics are listed, for the "Hidden" menu.
  const hiddenList = TOPICS.map((topic) => topic.id as string).filter((id) => hidden.has(id));

  // Keep the right column at least as long as the middle one. While the two sit
  // side by side and the right is shorter, reveal one more block, and again,
  // until it isn't or the blocks run out. Stacked layouts have nothing to match.
  useLayoutEffect(() => {
    const middle = middleRef.current;
    const right = rightRef.current;
    if (!active || !middle || !right) return;
    const sideBySide = window.matchMedia('(min-width: 1101px)').matches;
    if (sideBySide && right.offsetHeight < middle.offsetHeight && shownBlocks < newsBlocks.length) {
      setShownBlocks((count) => count + 1);
    }
  });

  // Left column: same parity, from the other end. The agenda list is capped so
  // a long day never stretches the page; the cap rises in steps while the whole
  // left column is still shorter than the middle one and the list holds hidden
  // content. Once the column matches, or the list is fully shown (it scrolls in
  // place beyond that), the cap stops moving.
  useLayoutEffect(() => {
    const left = leftColRef.current;
    const middle = middleRef.current;
    const agenda = agendaListRef.current;
    if (!active || !left || !middle || !agenda) return;
    if (!window.matchMedia('(min-width: 1101px)').matches) return;
    if (left.offsetHeight >= middle.offsetHeight) return;
    const missing = agenda.scrollHeight - agenda.clientHeight;
    if (missing <= 4) return; // nothing hidden left to reveal
    const step = Math.min(missing, Math.max(180, Math.round(middle.offsetHeight * 0.1)));
    setAgendaMaxHeight((current) => (current ?? agenda.clientHeight) + step);
  });

  // Re-check whenever either column changes size (charts loading, the window
  // being resized).
  useEffect(() => {
    const middle = middleRef.current;
    const right = rightRef.current;
    if (!isTauri || !middle || !right || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setLayoutTick((tick) => tick + 1));
    observer.observe(middle);
    observer.observe(right);
    return () => observer.disconnect();
  }, [isTauri]);

  // The insights feed under the Inana section, from Iris's weekly review.
  const allPosts = useMemo(() => buildPosts([...(irisFeed?.review_sections ?? []), ...(irisFeed?.brief_sections ?? [])], irisFeed?.insights ?? []), [irisFeed]);
  const posts = useMemo(() => allPosts.filter((post) => postChoices[postKey(post)]?.choice !== 'dismissed'), [allPosts, postChoices]);
  // An insight already on the task list (under its own title) is marked as added
  // even if that was done before the choice was remembered.
  const taskTitles = new Set(tasks.map((task) => task.label.trim().toLowerCase()));
  const isPostAdded = (post: Post) => postChoices[postKey(post)]?.choice === 'added' || (post.task !== undefined && taskTitles.has(post.task.title.trim().toLowerCase()));
  const addPostTask = async (post: Post) => {
      let saved: boolean;
      if (post.task) {
        // The task the insight names, as it is. Its source is not plain "Iris": that
        // marks an event taken from Suggested, whose day is read out of its text.
        saved = await addTask({ label: post.task.title, note: post.text === post.task.title ? '' : post.text, source: `${post.author} insight`, when: post.task.when });
      } else {
        const cut = post.text.lastIndexOf(' ', 79);
        const label = post.text.length > 80 ? `${post.text.slice(0, cut > 20 ? cut : 79)}…` : post.text;
        saved = await addTask({ label, note: label === post.text ? '' : post.text, source: post.author });
      }
      // Remembered, so it stays marked as added and a second click can't make a copy.
      // The boolean is consumed by InsightFeed: the card only leaves when the task
      // actually saved.
      if (saved) choosePost(post, 'added');
      return saved;
    };

    // Manual quote refresh: cycles to next quote in the combined pool.
    const refreshQuote = useCallback(() => {
      if (allQuotes.length === 0) return;
      setQuoteIndex((prev) => (prev + 1) % allQuotes.length);
    }, [allQuotes.length]);

    const today = new Date();
    // Base index from dayOfYear for daily consistency; manual refresh adds offset via quoteIndex
    const baseQuoteIndex = dayOfYear(today) % allQuotes.length;
    const effectiveQuoteIndex = (baseQuoteIndex + quoteIndex) % allQuotes.length;
    const quote = allQuotes[effectiveQuoteIndex] ?? QUOTES[0];

  if (!isTauri) {
    return (
      <div className="dd-root">
        <p className="dd-fine">The Daily dashboard needs the desktop app.</p>
      </div>
    );
  }

  const inanaProps = {
    status: inana.status,
    data: inana.data,
    config: inana.config,
    scope,
    error: inana.error,
    onOpenLink: openLink,
    onConnect: onOpenSettings,
    onRetry: inana.refresh,
  };

  return (
    <div className="dd-root">
      <div className="dd-grid">
        {/* ---- Left: today at a glance, tasks ---- */}
        <div className="dd-col dd-col-left" ref={leftColRef}>
          <Reveal>
            <div className="dd-hero">
              <div className="dd-hero-date">
                <span className="dd-day">{today.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</span>
                <span className="dd-date">{today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              </div>
              <div className="dd-weather">
                <div className="dd-weather-ring" title={weather?.condition}>
                  {weather ? <WeatherGlyph code={weather.weather_code} isDay={weather.is_day} size={26} /> : <span className="dd-ring-pulse" />}
                </div>
                <div className="dd-weather-read">
                  <span className="dd-temp">
                    {weather ? Math.round(weather.temperature_f) : '–'}
                    <sup>°</sup>
                  </span>
                  <span className="dd-weather-loc">{weather?.location ?? location?.label ?? ''}</span>
                </div>
              </div>
            </div>
            {weather && (
              <p className="dd-weather-cond">
                {weather.condition} · wind {Math.round(weather.wind_mph)} mph
              </p>
            )}
            {weatherError && <p className="dd-fine">{weatherError}</p>}
          </Reveal>

          <hr className="dd-rule dd-rule-flat" />

          <Reveal delay={0.08} className="dd-stack">
            <TasksPanel
              tasks={tasks}
              agendaMaxHeight={agendaMaxHeight}
              agendaListRef={agendaListRef}
              scheduled={scheduled}
              nextCards={nextCards}
              pendingCards={pendingCards}
              suggestedCards={suggestedCards}
              finishedCards={finishedCards}
              irisSuggestion={irisSuggestion}
              accepting={accepting}
              notice={cardNotice}
              scout={scout}
              onAdd={addTask}
              onToggle={toggleTask}
              onRemove={removeTask}
              onCancelScheduled={cancelScheduled}
              onIrisAnswer={answerSuggestion}
              onAcceptCard={acceptCard}
              onDismissCard={dismissCard}
              onCompleteCard={completeCard}
              onUndoFinished={undoFinished}
              onOpenLink={openLink}
              onAskScout={scout.ask}
            />
          </Reveal>
        </div>

        {/* ---- Middle: the day's reading, goals, Inana ---- */}
        <div className="dd-col dd-col-mid" ref={middleRef}>
          <Reveal delay={0.04}>
            <div className="dd-greeting-row">
              <h1 className="dd-greeting">
                hello bravetraveler<span className="dd-caret">_</span>
              </h1>
              <div className="dd-greeting-tools">
                <HiddenSections hidden={hiddenList} onShow={show} onShowAll={showAll} />
                <LocationPicker label={weather?.location ?? location?.label ?? 'Set location'} onChanged={loadWeather} />
              </div>
            </div>
            {phoneFeed.note && (
              <p className="dd-fine dd-sync-note" role="status">
                {phoneFeed.note}
                {phoneFeed.needsSettings && (
                  <>
                    {' '}
                    <button type="button" className="dd-link" onClick={onOpenSettings}>
                      Open Settings
                    </button>
                  </>
                )}
              </p>
            )}
          </Reveal>

          <Reveal delay={0.1}>
                      <section className="dd-section">
                        <p className="dd-quote-line">
                          &gt; {quote.text} — {quote.by}, <em>{quote.work}</em>
                          <button
                            type="button"
                            className="dd-quote-refresh"
                            onClick={refreshQuote}
                            disabled={allQuotes.length <= 1}
                            aria-label="Refresh quote"
                            title="Cycle to next quote"
                          >
                            <RefreshCw size={14} className={quoteLoading ? 'dd-spin' : ''} />
                          </button>
                        </p>
                      </section>
                    </Reveal>

          <Reveal delay={0.16}>
            {!hidden.has('top') && (
              <section className="dd-section">
                <div className="dd-section-head dd-head-center">
                  <h2 className="dd-section-title">Top Story</h2>
                  <HideButton label="Top Story" onHide={() => hide('top')} />
                </div>
                {newsError && <p className="dd-fine">{newsError}</p>}
                {news === null && !newsError && <div className="dd-story dd-skeleton" aria-hidden />}
                {news !== null && !topStory && <p className="dd-fine">No headlines right now.</p>}
                {topStory && <TopStory item={topStory} onOpen={openLink} onBroken={reportBroken} />}
              </section>
            )}
          </Reveal>

          <Reveal delay={0.26}>
            <hr className="dd-rule" />
          </Reveal>

          <Reveal delay={0.28}>
            <GoalsWidget sections={goals} weekly={weekly} taps={goalTaps} error={goalsError} loaded={goalsLoaded} breakingDown={breakingDown} onToggle={toggleGoal} onBreakDown={breakDownGoal} onOpenGoals={onOpenGoals} onStartSession={onStartGoalSession} />
          </Reveal>

          {!isAndroid && (
            <Reveal delay={0.34}>
              <InanaInsight {...inanaProps} refreshing={inana.refreshing} onScopeChange={setScope} onRefresh={inana.refresh} />
            </Reveal>
          )}

          {allPosts.length > 0 && (
            <Reveal delay={0.38}>
              <InsightFeed
                posts={posts}
                updated={irisFeed?.updated ?? ''}
                isAdded={isPostAdded}
                onAddTask={addPostTask}
                onDismiss={(post) => choosePost(post, 'dismissed')}
                dismissed={allPosts.length - posts.length}
                onRestore={restorePosts}
              />
            </Reveal>
          )}

          {/* ---- Taste shelves last: restaurants/bars and cooking, side by side with nothing below ---- */}
          {(irisFeed?.recs?.length ?? 0) > 0 && (
            <Reveal delay={0.42}>
              <section className="dd-section">
                <div className="dd-section-head dd-head-center">
                  <h2 className="dd-section-title">Worth a taste</h2>
                </div>
                <TasteStrip recs={irisFeed?.recs ?? []} onOpenLink={openLink} onAddRec={addRec} />
              </section>
            </Reveal>
          )}
        </div>

        {/* ---- Right: Inana's headline numbers, then news in varied categories and styles ---- */}
        <div className="dd-col dd-col-right" ref={rightRef}>
          {/* The top-right corner of the tab: Inana's headline numbers, and the button that refreshes everything. */}
          <div className="dd-top-right">
            {!isAndroid && (
              <Reveal delay={0.06} className="dd-kpi-wrap">
                <InanaKpis {...inanaProps} />
              </Reveal>
            )}
            <button
              type="button"
              className="dd-refresh"
              onClick={refreshAll}
              disabled={refreshing}
              aria-label="Refresh everything"
              title="Refresh everything: weather, news, tasks, goals, Iris's feed and Inana"
            >
              <RefreshCw size={16} className={refreshing ? 'dd-spin' : ''} />
            </button>
          </div>

          <div className="dd-right-body">
            {news === null && !newsError && <div className="dd-feature dd-skeleton" aria-hidden />}
            {news !== null && newsBlocks.length === 0 && (
              <p className="dd-fine">{hidden.size > 0 ? 'Nothing left to show. Use Hidden at the top to bring sections back.' : 'No stories with pictures right now.'}</p>
            )}
            {newsBlocks.slice(0, shownBlocks).map((block, index) => (
              <Reveal key={block.key} delay={Math.min(index, 4) * 0.06} className="dd-news-block">
                <NewsBlockBody block={block} onOpen={openLink} onBroken={reportBroken} onHide={hide} />
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
