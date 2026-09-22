// Turns the raw payload from `fetch_inana_data` into (a) the few metrics worth
// headlining and (b) chart series. Pure functions only — no React, no I/O — so
// the selection rules can be run and checked on their own.
//
// Inana's API returns no previous-period figures, so "what changed" is computed
// here from the 30-day daily series it does return: the last 7 complete days
// against the 7 before them.

export interface MetaInsights {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  landingPageViews: number;
  purchaseValue: number;
}

export interface DailyPoint {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
}

export interface InanaMetaAccount {
  product_id: string;
  product_name: string;
  account: { name: string; account_id: string; currency?: string };
  insights: MetaInsights | null;
  daily: DailyPoint[];
}

export interface InanaStripe {
  currency?: string;
  revenueLast30d: number;
  mrr: number;
  dailyRevenue: { date: string; revenue: number }[];
}

export interface InanaGa4 {
  product_id: string;
  product_name: string;
  summary: { sessions: number; dailySessions?: { date: string; sessions: number }[] };
}

export interface InanaProduct {
  id: string;
  name: string;
}

export interface InanaData {
  fetched_at: string;
  products: InanaProduct[];
  meta: InanaMetaAccount[];
  ga4: InanaGa4[];
  stripe: InanaStripe | null;
  errors: string[];
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// ---- Dates ------------------------------------------------------------------
// Everything is compared as "YYYY-MM-DD" strings. Parsing those with
// `new Date(string)` reads them as UTC, which shows the wrong day in US time
// zones — so labels are built from the parts instead.

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateLabel(key: string): string {
  const [, month, day] = key.split('-').map(Number);
  return `${MONTHS[(month || 1) - 1]} ${day}`;
}

interface Windows {
  recentStart: string;
  recentEnd: string;
  priorStart: string;
  priorEnd: string;
}

// Ends at yesterday: today's numbers are still accumulating and would make
// every metric look like it just fell.
export function comparisonWindows(now: Date): Windows {
  const end = shiftDays(now, -1);
  return {
    recentEnd: toDateKey(end),
    recentStart: toDateKey(shiftDays(end, -6)),
    priorEnd: toDateKey(shiftDays(end, -7)),
    priorStart: toDateKey(shiftDays(end, -13)),
  };
}

function sumBetween<T extends { date: string }>(rows: T[], start: string, end: string, pick: (row: T) => number): number {
  let total = 0;
  for (const row of rows) {
    const key = row.date.slice(0, 10);
    if (key >= start && key <= end) total += pick(row);
  }
  return total;
}

// ---- Scoping and aggregation ------------------------------------------------

export function scopeAccounts(data: InanaData, scope: string): InanaMetaAccount[] {
  return scope === 'all' ? data.meta : data.meta.filter((account) => account.product_id === scope);
}

export function mergeDaily(accounts: InanaMetaAccount[]): DailyPoint[] {
  const byDate = new Map<string, DailyPoint>();
  for (const account of accounts) {
    for (const point of account.daily ?? []) {
      const key = point.date.slice(0, 10);
      const existing = byDate.get(key) ?? { date: key, spend: 0, impressions: 0, clicks: 0 };
      existing.spend += num(point.spend);
      existing.impressions += num(point.impressions);
      existing.clicks += num(point.clicks);
      byDate.set(key, existing);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function sumInsights(accounts: InanaMetaAccount[]): MetaInsights | null {
  const withInsights = accounts.filter((account) => account.insights);
  if (withInsights.length === 0) return null;
  const total: MetaInsights = { spend: 0, impressions: 0, clicks: 0, conversions: 0, landingPageViews: 0, purchaseValue: 0 };
  for (const { insights } of withInsights) {
    if (!insights) continue;
    total.spend += num(insights.spend);
    total.impressions += num(insights.impressions);
    total.clicks += num(insights.clicks);
    total.conversions += num(insights.conversions);
    total.landingPageViews += num(insights.landingPageViews);
    total.purchaseValue += num(insights.purchaseValue);
  }
  return total;
}

// ---- Metrics ----------------------------------------------------------------

export type MetricKey =
  | 'revenue'
  | 'spend'
  | 'landing'
  | 'conversions'
  | 'adRevenue'
  | 'sessions'
  | 'mrr'
  | 'clicks'
  | 'roas'
  | 'ctr'
  | 'cpc'
  | 'impressions';

export type MetricFormat = 'currency' | 'count' | 'percent' | 'ratio';
export type Polarity = 'up' | 'down' | 'neutral';

// Metrics in one family are views of the same movement (clicks and CTR rise
// together), so the headline row prefers one per family — three different
// stories rather than three angles on one.
type MetricFamily = 'traffic' | 'cost' | 'revenue' | 'conversion';

interface MetricDefinition {
  label: string;
  family: MetricFamily;
  format: MetricFormat;
  // Which direction of change is good news — drives the arrow's colour only.
  polarity: Polarity;
  // Higher = more important. Used to fill headline slots when too few metrics
  // have a trustworthy change to rank.
  importance: number;
  // Where the metric lives in Inana (a real route in MarketGenius).
  page: string;
  // A % change on a tiny base is noise (2 clicks -> 5 clicks is "+150%"), so a
  // change only counts once the underlying volume clears this.
  minVolume: number;
}

export const METRICS: Record<MetricKey, MetricDefinition> = {
  revenue: { label: 'Revenue', family: 'revenue', format: 'currency', polarity: 'up', importance: 100, page: '/inanna/today', minVolume: 5 },
  spend: { label: 'Spending', family: 'cost', format: 'currency', polarity: 'neutral', importance: 90, page: '/campaigns/meta-ads', minVolume: 5 },
  landing: { label: 'Landing', family: 'traffic', format: 'count', polarity: 'up', importance: 80, page: '/campaigns/meta-ads', minVolume: 10 },
  conversions: { label: 'Conversions', family: 'conversion', format: 'count', polarity: 'up', importance: 75, page: '/campaigns/meta-ads', minVolume: 3 },
  adRevenue: { label: 'Ad revenue', family: 'revenue', format: 'currency', polarity: 'up', importance: 70, page: '/campaigns/meta-ads', minVolume: 5 },
  sessions: { label: 'Sessions', family: 'traffic', format: 'count', polarity: 'up', importance: 60, page: '/results/channels', minVolume: 20 },
  mrr: { label: 'MRR', family: 'revenue', format: 'currency', polarity: 'up', importance: 55, page: '/inanna/today', minVolume: 5 },
  clicks: { label: 'Clicks', family: 'traffic', format: 'count', polarity: 'up', importance: 50, page: '/campaigns/meta-ads', minVolume: 20 },
  roas: { label: 'ROAS', family: 'revenue', format: 'ratio', polarity: 'up', importance: 45, page: '/campaigns/meta-ads', minVolume: 5 },
  ctr: { label: 'CTR', family: 'traffic', format: 'percent', polarity: 'up', importance: 40, page: '/campaigns/meta-ads', minVolume: 20 },
  cpc: { label: 'Cost / click', family: 'traffic', format: 'currency', polarity: 'down', importance: 35, page: '/campaigns/meta-ads', minVolume: 20 },
  impressions: { label: 'Impressions', family: 'traffic', format: 'count', polarity: 'up', importance: 30, page: '/campaigns/meta-ads', minVolume: 200 },
};

export interface MetricReading {
  key: MetricKey;
  label: string;
  family: MetricFamily;
  value: number;
  format: MetricFormat;
  display: string;
  // "7d" = the last 7 complete days, "30d" = Inana's rolling 30-day total,
  // "now" = a point-in-time figure.
  window: '7d' | '30d' | 'now';
  deltaPct: number | null;
  // Went from nothing to something — a change with no meaningful percentage.
  isNew: boolean;
  // 0 when there is no trustworthy change; otherwise how big it was (capped so
  // one runaway ratio can't crowd out everything else).
  changeScore: number;
  polarity: Polarity;
  importance: number;
  page: string;
  scope: string;
}

const MAX_CHANGE_SCORE = 300;
const NEW_METRIC_SCORE = 100;
const MIN_MEANINGFUL_CHANGE_PCT = 1;

export function formatValue(value: number, format: MetricFormat): string {
  switch (format) {
    case 'currency':
      if (value >= 10000) return `$${(value / 1000).toFixed(1)}k`;
      if (value >= 100) return `$${Math.round(value).toLocaleString('en-US')}`;
      return `$${value.toFixed(2)}`;
    case 'count':
      if (value >= 100000) return `${Math.round(value / 1000)}k`;
      if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
      return Math.round(value).toLocaleString('en-US');
    case 'percent':
      return `${value.toFixed(2)}%`;
    case 'ratio':
      return `${value.toFixed(1)}×`;
  }
}

interface ReadingInput {
  key: MetricKey;
  value: number;
  previous: number | null;
  window: MetricReading['window'];
  // The raw count the change rests on (for a ratio like CTR, its clicks).
  volume: number;
  scope: string;
}

function makeReading({ key, value, previous, window, volume, scope }: ReadingInput): MetricReading {
  const definition = METRICS[key];
  const enoughVolume = volume >= definition.minVolume;

  let deltaPct: number | null = null;
  let isNew = false;
  let changeScore = 0;

  if (previous !== null) {
    if (previous === 0 && value > 0) {
      isNew = true;
      changeScore = enoughVolume ? NEW_METRIC_SCORE : 0;
    } else if (previous > 0) {
      deltaPct = ((value - previous) / previous) * 100;
      if (enoughVolume && Math.abs(deltaPct) >= MIN_MEANINGFUL_CHANGE_PCT) {
        changeScore = Math.min(Math.abs(deltaPct), MAX_CHANGE_SCORE);
      }
    }
  }

  return {
    key,
    label: definition.label,
    family: definition.family,
    value,
    format: definition.format,
    display: formatValue(value, definition.format),
    window,
    deltaPct,
    isNew,
    changeScore,
    polarity: definition.polarity,
    importance: definition.importance,
    page: definition.page,
    scope,
  };
}

export function buildReadings(data: InanaData, scope: string, now: Date = new Date()): MetricReading[] {
  const windows = comparisonWindows(now);
  const accounts = scopeAccounts(data, scope);
  const daily = mergeDaily(accounts);
  const insights = sumInsights(accounts);
  const readings: MetricReading[] = [];

  // Meta, from the daily series: a real last-7-vs-prior-7 comparison.
  const recent = (key: 'spend' | 'impressions' | 'clicks') => sumBetween(daily, windows.recentStart, windows.recentEnd, (row) => row[key]);
  const prior = (key: 'spend' | 'impressions' | 'clicks') => sumBetween(daily, windows.priorStart, windows.priorEnd, (row) => row[key]);

  const spendNow = recent('spend');
  const spendBefore = prior('spend');
  const clicksNow = recent('clicks');
  const clicksBefore = prior('clicks');
  const impressionsNow = recent('impressions');
  const impressionsBefore = prior('impressions');

  if (spendNow > 0 || spendBefore > 0) {
    readings.push(makeReading({ key: 'spend', value: spendNow, previous: spendBefore, window: '7d', volume: Math.max(spendNow, spendBefore), scope }));
  } else if (insights && insights.spend > 0) {
    readings.push(makeReading({ key: 'spend', value: insights.spend, previous: null, window: '30d', volume: insights.spend, scope }));
  }

  if (clicksNow > 0 || clicksBefore > 0) {
    readings.push(makeReading({ key: 'clicks', value: clicksNow, previous: clicksBefore, window: '7d', volume: Math.max(clicksNow, clicksBefore), scope }));
  } else if (insights && insights.clicks > 0) {
    readings.push(makeReading({ key: 'clicks', value: insights.clicks, previous: null, window: '30d', volume: insights.clicks, scope }));
  }

  if (impressionsNow > 0 || impressionsBefore > 0) {
    readings.push(
      makeReading({ key: 'impressions', value: impressionsNow, previous: impressionsBefore, window: '7d', volume: Math.max(impressionsNow, impressionsBefore), scope }),
    );
  }

  // Ratios — only meaningful when there's a denominator on the side they describe.
  if (impressionsNow > 0) {
    const ctrNow = (clicksNow / impressionsNow) * 100;
    const ctrBefore = impressionsBefore > 0 ? (clicksBefore / impressionsBefore) * 100 : null;
    readings.push(makeReading({ key: 'ctr', value: ctrNow, previous: ctrBefore, window: '7d', volume: Math.max(clicksNow, clicksBefore), scope }));
  }
  if (clicksNow > 0) {
    const cpcNow = spendNow / clicksNow;
    const cpcBefore = clicksBefore > 0 ? spendBefore / clicksBefore : null;
    readings.push(makeReading({ key: 'cpc', value: cpcNow, previous: cpcBefore, window: '7d', volume: Math.max(clicksNow, clicksBefore), scope }));
  }

  // Meta, 30-day totals with no series behind them: candidates only for the
  // "most important" fallback, since there's nothing to compare against.
  if (insights) {
    if (insights.landingPageViews > 0) {
      readings.push(makeReading({ key: 'landing', value: insights.landingPageViews, previous: null, window: '30d', volume: insights.landingPageViews, scope }));
    }
    if (insights.conversions > 0) {
      readings.push(makeReading({ key: 'conversions', value: insights.conversions, previous: null, window: '30d', volume: insights.conversions, scope }));
    }
    if (insights.purchaseValue > 0) {
      readings.push(makeReading({ key: 'adRevenue', value: insights.purchaseValue, previous: null, window: '30d', volume: insights.purchaseValue, scope }));
      if (insights.spend > 0) {
        readings.push(makeReading({ key: 'roas', value: insights.purchaseValue / insights.spend, previous: null, window: '30d', volume: insights.purchaseValue, scope }));
      }
    }
  }

  // Stripe is workspace-wide — Inana can't attribute it to one product — so it
  // only counts when looking at everything.
  if (scope === 'all' && data.stripe) {
    const series = data.stripe.dailyRevenue ?? [];
    const revenueNow = sumBetween(series, windows.recentStart, windows.recentEnd, (row) => num(row.revenue));
    const revenueBefore = sumBetween(series, windows.priorStart, windows.priorEnd, (row) => num(row.revenue));
    if (revenueNow > 0 || revenueBefore > 0) {
      readings.push(makeReading({ key: 'revenue', value: revenueNow, previous: revenueBefore, window: '7d', volume: Math.max(revenueNow, revenueBefore), scope }));
    } else if (num(data.stripe.revenueLast30d) > 0) {
      readings.push(makeReading({ key: 'revenue', value: data.stripe.revenueLast30d, previous: null, window: '30d', volume: data.stripe.revenueLast30d, scope }));
    }
    if (num(data.stripe.mrr) > 0) {
      readings.push(makeReading({ key: 'mrr', value: data.stripe.mrr, previous: null, window: 'now', volume: data.stripe.mrr, scope }));
    }
  }

  const sessions = (scope === 'all' ? data.ga4 : data.ga4.filter((entry) => entry.product_id === scope)).reduce(
    (total, entry) => total + num(entry.summary?.sessions),
    0,
  );
  if (sessions > 0) {
    readings.push(makeReading({ key: 'sessions', value: sessions, previous: null, window: '30d', volume: sessions, scope }));
  }

  return readings;
}

// The rule: whatever changed the most; and where too few things changed (or
// there's nothing to compare against), the most important numbers overall.
//
// Among the things that changed, the biggest mover of each family goes first,
// so clicks and CTR (one movement, two names) don't crowd out revenue. Real
// changes from a family already shown still beat any unchanged metric.
export function pickHeadline(readings: MetricReading[], count = 3): MetricReading[] {
  const changed = readings
    .filter((reading) => reading.changeScore > 0)
    .sort((a, b) => b.changeScore - a.changeScore || b.importance - a.importance);

  const picked: MetricReading[] = [];
  const familiesShown = new Set<MetricFamily>();
  for (const reading of changed) {
    if (picked.length < count && !familiesShown.has(reading.family)) {
      picked.push(reading);
      familiesShown.add(reading.family);
    }
  }
  for (const reading of changed) {
    if (picked.length < count && !picked.includes(reading)) picked.push(reading);
  }

  if (picked.length < count) {
    const remaining = readings.filter((reading) => !picked.includes(reading)).sort((a, b) => b.importance - a.importance);
    picked.push(...remaining.slice(0, count - picked.length));
  }

  return picked.sort((a, b) => {
    const aChanged = a.changeScore > 0 ? 1 : 0;
    const bChanged = b.changeScore > 0 ? 1 : 0;
    return bChanged - aChanged || b.changeScore - a.changeScore || b.importance - a.importance;
  });
}

export function windowCaption(reading: MetricReading): string {
  if (reading.window === 'now') return 'current';
  return reading.window === '7d' ? 'last 7 days' : 'last 30 days';
}

export function changeCaption(reading: MetricReading): string {
  if (reading.isNew) return 'new vs prior week';
  if (reading.deltaPct === null || reading.changeScore === 0) return windowCaption(reading);
  const rounded = Math.abs(reading.deltaPct) >= 10 ? Math.round(Math.abs(reading.deltaPct)) : Math.abs(reading.deltaPct).toFixed(1);
  return `${reading.deltaPct >= 0 ? '▲' : '▼'} ${rounded}% vs prior week`;
}

// Which way a metric moved, for the small arrow beside its number. Null when
// there is no trustworthy change to point at (the exact figure lives in the
// tile's tooltip, via changeCaption).
export function changeDirection(reading: MetricReading): 'up' | 'down' | null {
  if (reading.isNew) return 'up';
  if (reading.changeScore === 0 || reading.deltaPct === null) return null;
  return reading.deltaPct >= 0 ? 'up' : 'down';
}

export type ChangeTone = 'good' | 'bad' | 'neutral';

export function changeTone(reading: MetricReading): ChangeTone {
  if (reading.changeScore === 0 || reading.polarity === 'neutral') return 'neutral';
  const rising = reading.isNew || (reading.deltaPct ?? 0) > 0;
  return rising === (reading.polarity === 'up') ? 'good' : 'bad';
}

export function inanaUrl(webUrl: string, page: string, scope: string): string {
  return `${webUrl.replace(/\/+$/, '')}${page}?product=${encodeURIComponent(scope)}`;
}

// ---- Chart series -----------------------------------------------------------

export interface TrendPoint {
  date: string;
  label: string;
  spend: number;
  revenue: number | null;
}

export interface Trend {
  points: TrendPoint[];
  totalSpend: number;
  totalRevenue: number | null;
}

// Zero-fills the gaps between the first and last day with data. An area chart
// draws a straight line across a missing day, which would misreport a day of
// no spend as a smooth slope between its neighbours.
export function buildTrend(data: InanaData, scope: string, now: Date = new Date()): Trend {
  const daily = mergeDaily(scopeAccounts(data, scope));
  const revenueRows = scope === 'all' && data.stripe ? data.stripe.dailyRevenue ?? [] : [];
  const hasRevenue = revenueRows.length > 0;

  const spendByDate = new Map(daily.map((point) => [point.date, point.spend]));
  const revenueByDate = new Map<string, number>();
  for (const row of revenueRows) {
    const key = row.date.slice(0, 10);
    revenueByDate.set(key, (revenueByDate.get(key) ?? 0) + num(row.revenue));
  }

  const dates = [...spendByDate.keys(), ...revenueByDate.keys()].sort();
  if (dates.length === 0) return { points: [], totalSpend: 0, totalRevenue: null };

  // Inana's "last 30 days" is 30 complete days ending yesterday.
  const windowStart = toDateKey(shiftDays(now, -30));
  const first = dates[0] > windowStart ? dates[0] : windowStart;
  const yesterday = toDateKey(shiftDays(now, -1));
  const lastData = dates[dates.length - 1];
  const last = lastData > yesterday ? lastData : yesterday;

  const points: TrendPoint[] = [];
  const [firstYear, firstMonth, firstDay] = first.split('-').map(Number);
  for (let cursor = new Date(firstYear, firstMonth - 1, firstDay); toDateKey(cursor) <= last; cursor = shiftDays(cursor, 1)) {
    const key = toDateKey(cursor);
    points.push({
      date: key,
      label: dateLabel(key),
      spend: spendByDate.get(key) ?? 0,
      revenue: hasRevenue ? revenueByDate.get(key) ?? 0 : null,
    });
  }

  return {
    points,
    totalSpend: points.reduce((total, point) => total + point.spend, 0),
    totalRevenue: hasRevenue ? points.reduce((total, point) => total + (point.revenue ?? 0), 0) : null,
  };
}

export interface MetaSummary {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
}

export function buildMetaSummary(data: InanaData, scope: string): MetaSummary | null {
  const insights = sumInsights(scopeAccounts(data, scope));
  if (!insights) return null;
  return {
    spend: insights.spend,
    impressions: insights.impressions,
    clicks: insights.clicks,
    ctr: insights.impressions > 0 ? (insights.clicks / insights.impressions) * 100 : 0,
    conversions: insights.conversions,
  };
}

export function scopeOptions(data: InanaData): InanaProduct[] {
  const withMeta = new Set(data.meta.map((account) => account.product_id));
  return data.products.filter((product) => withMeta.has(product.id));
}
