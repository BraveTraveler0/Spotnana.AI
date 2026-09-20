import { useMemo } from 'react';
import DropdownSelect from './DropdownSelect';
import { ArrowDown, ArrowUp, ArrowUpRight, Link2, Loader2, RefreshCw } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  buildMetaSummary,
  buildReadings,
  buildTrend,
  changeCaption,
  changeDirection,
  changeTone,
  formatValue,
  inanaUrl,
  pickHeadline,
  scopeOptions,
  type InanaData,
} from './inana';
import type { InanaConfig, InanaStatus } from './useInana';

const SPEND_COLOR = '#8b7cf6';
const REVENUE_COLOR = '#d6fe81';

interface PanelProps {
  status: InanaStatus;
  data: InanaData | null;
  config: InanaConfig | null;
  scope: string;
  error: string;
  onOpenLink: (url: string) => void;
  onConnect: () => void;
  onRetry: () => void;
}

// What to show in place of numbers/charts when there's nothing to draw yet.
function stateMessage(status: InanaStatus, data: InanaData | null): { text: string; action: 'connect' | 'retry' | 'open' | null; label: string } | null {
  if (status === 'idle') return { text: 'Connect Inana to see live spend, revenue and traffic here.', action: 'connect', label: 'Connect Inana' };
  if (status === 'expired') return { text: 'Your Inana session has expired.', action: 'connect', label: 'Sign in again' };
  if (status === 'error') return { text: "Couldn't reach Inana.", action: 'retry', label: 'Try again' };
  if (status === 'ready' && data && data.meta.length === 0 && !data.stripe) {
    return { text: "Inana is connected, but no ad account or Stripe is linked yet — link one inside Inana and it'll show up here.", action: 'open', label: 'Open Inana' };
  }
  return null;
}

// ---- Headline numbers (right column) ---------------------------------------

const GHOST_LABELS = ['Landing', 'Spending', 'Revenue'];

export function InanaKpis({ status, data, config, scope, error, onOpenLink, onConnect, onRetry }: PanelProps) {
  const headline = useMemo(() => (data ? pickHeadline(buildReadings(data, scope)) : []), [data, scope]);
  const webUrl = config?.web_url ?? '';

  if (status === 'loading' || (status === 'ready' && headline.length > 0)) {
    return (
      <div className="dd-kpis" aria-label="Inana headline numbers">
        {status === 'loading'
          ? GHOST_LABELS.map((label) => (
              <div className="dd-kpi dd-kpi-skeleton" key={label} aria-hidden>
                <span className="dd-kpi-value">&nbsp;</span>
                <span className="dd-kpi-label">{label}</span>
              </div>
            ))
          : headline.map((reading) => {
              const tone = changeTone(reading);
              const direction = changeDirection(reading);
              const detail = changeCaption(reading);
              return (
                <button
                  type="button"
                  key={reading.key}
                  className="dd-kpi dd-kpi-live"
                  onClick={() => onOpenLink(inanaUrl(webUrl, reading.page, reading.scope))}
                  title={`${detail} — open ${reading.label} in Inana`}
                  aria-label={`${reading.label} ${reading.display}, ${detail}. Opens in Inana.`}
                >
                  <span className="dd-kpi-value">
                    {reading.display}
                    {direction && (
                      <span className={`dd-kpi-trend tone-${tone}`} aria-hidden>
                        {direction === 'up' ? <ArrowUp size={14} strokeWidth={2.4} /> : <ArrowDown size={14} strokeWidth={2.4} />}
                      </span>
                    )}
                  </span>
                  <span className="dd-kpi-label">{reading.label}</span>
                </button>
              );
            })}
      </div>
    );
  }

  // Not connected, signed out or unreachable: say nothing here. The Inana
  // section below is the one place that explains it and offers to fix it.
  return null;
}

// ---- Charts (middle column) --------------------------------------------------

interface TooltipPayload {
  dataKey?: string | number;
  name?: string;
  value?: number;
  color?: string;
}

function GlassTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="dd-tooltip">
      <div className="dd-tooltip-label">{label}</div>
      {payload.map((entry) => (
        <div className="dd-tooltip-row" key={String(entry.dataKey)}>
          <span className="dd-dot" style={{ background: entry.color }} />
          <span>{entry.name}</span>
          <strong>${Number(entry.value ?? 0).toFixed(2)}</strong>
        </div>
      ))}
    </div>
  );
}

const money = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface InsightProps extends PanelProps {
  refreshing: boolean;
  onScopeChange: (scope: string) => void;
  onRefresh: () => void;
}

export function InanaInsight({ status, data, config, scope, error, refreshing, onScopeChange, onRefresh, onOpenLink, onConnect, onRetry }: InsightProps) {
  const trend = useMemo(() => (data ? buildTrend(data, scope) : null), [data, scope]);
  const meta = useMemo(() => (data ? buildMetaSummary(data, scope) : null), [data, scope]);
  const options = useMemo(() => (data ? scopeOptions(data) : []), [data]);
  const webUrl = config?.web_url ?? '';
  const message = stateMessage(status, data);

  const openHome = () => onOpenLink(inanaUrl(webUrl, '/inanna/today', scope));
  const openMeta = () => onOpenLink(inanaUrl(webUrl, '/campaigns/meta-ads', scope));

  return (
    <section className="dd-section">
      <div className="dd-section-head">
        <h2 className="dd-section-title">Inana&rsquo;s Insight</h2>
        {status === 'ready' && (
          <div className="dd-insight-tools">
            {options.length > 1 && (
              <DropdownSelect
                value={scope}
                options={[{ value: 'all', label: 'All products' }, ...options.map((product) => ({ value: product.id, label: product.name }))]}
                onChange={onScopeChange}
                ariaLabel="Product scope"
              />
            )}
            <button type="button" className="dd-icon-button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh Inana data" title="Refresh">
              <RefreshCw size={14} className={refreshing ? 'dd-spin' : ''} />
            </button>
          </div>
        )}
      </div>

      {status === 'loading' && (
        <div className="dd-card dd-chart-card dd-loading-card">
          <Loader2 size={18} className="dd-spin" /> Reading your numbers…
        </div>
      )}

      {message && (
        <div className="dd-card dd-empty-card">
          <p>{message.text}</p>
          <button
            type="button"
            className="dd-pill"
            onClick={message.action === 'connect' ? onConnect : message.action === 'retry' ? onRetry : openHome}
          >
            <Link2 size={13} /> {message.label}
          </button>
          {status === 'error' && error && <p className="dd-fine">{error}</p>}
        </div>
      )}

      {status === 'ready' && trend && trend.points.length > 0 && (
        <div className="dd-card dd-chart-card">
          <div className="dd-chart-head">
            <div>
              <div className="dd-chart-kicker">Spend{trend.totalRevenue !== null ? ' & revenue' : ''}</div>
              <div className="dd-chart-total">
                ${money(trend.totalSpend)} <span>USD</span>
              </div>
              <div className="dd-chart-sub">Last 30 days</div>
            </div>
            <div className="dd-chart-side">
              <div className="dd-legend">
                <span>
                  <i className="dd-dot" style={{ background: SPEND_COLOR }} /> Spend
                </span>
                {trend.totalRevenue !== null && (
                  <span>
                    <i className="dd-dot" style={{ background: REVENUE_COLOR }} /> Revenue ${money(trend.totalRevenue)}
                  </span>
                )}
              </div>
              <button type="button" className="dd-link" onClick={openHome}>
                Open <ArrowUpRight size={12} />
              </button>
            </div>
          </div>
          <div className="dd-chart" style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend.points} margin={{ top: 8, right: 6, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="ddSpendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={SPEND_COLOR} stopOpacity={0.38} />
                    <stop offset="100%" stopColor={SPEND_COLOR} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ddRevenueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={REVENUE_COLOR} stopOpacity={0.24} />
                    <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.42)' }} tickLine={false} axisLine={false} minTickGap={26} />
                <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.42)' }} tickLine={false} axisLine={false} width={46} tickFormatter={(value) => `$${value}`} />
                <Tooltip content={<GlassTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.22)' }} />
                {trend.totalRevenue !== null && (
                  <Area className="dd-area-revenue" type="monotone" dataKey="revenue" name="Revenue" stroke={REVENUE_COLOR} strokeWidth={2} fill="url(#ddRevenueGrad)" dot={false} activeDot={{ r: 4, fill: REVENUE_COLOR, stroke: '#0b1a35', strokeWidth: 2 }} />
                )}
                <Area className="dd-area-spend" type="monotone" dataKey="spend" name="Spend" stroke={SPEND_COLOR} strokeWidth={2.2} fill="url(#ddSpendGrad)" dot={false} activeDot={{ r: 4, fill: SPEND_COLOR, stroke: '#0b1a35', strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {status === 'ready' && meta && trend && trend.points.length > 0 && (
        <div className="dd-card dd-chart-card">
          <div className="dd-chart-head">
            <div>
              <div className="dd-chart-kicker">
                Meta Ads <span className="dd-live">Live</span>
              </div>
              <div className="dd-chart-sub">Real data from your connected ad account — last 30 days</div>
            </div>
            <button type="button" className="dd-link" onClick={openMeta}>
              Open <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="dd-meta-grid">
            <div className="dd-meta-tile">
              <span>Spend</span>
              <strong>${money(meta.spend)}</strong>
              <em>last 30 days</em>
            </div>
            <div className="dd-meta-tile">
              <span>Impressions</span>
              <strong>{meta.impressions.toLocaleString('en-US')}</strong>
              <em>last 30 days</em>
            </div>
            <div className="dd-meta-tile">
              <span>Clicks</span>
              <strong>{meta.clicks.toLocaleString('en-US')}</strong>
              <em>CTR {formatValue(meta.ctr, 'percent')}</em>
            </div>
            <div className="dd-meta-tile">
              <span>Conversions</span>
              <strong>{meta.conversions.toLocaleString('en-US')}</strong>
              <em>purchases + leads + signups</em>
            </div>
          </div>
          <div className="dd-chart-kicker dd-chart-kicker-small">Daily spend</div>
          <div className="dd-chart" style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend.points} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="ddDailyGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={REVENUE_COLOR} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.42)' }} tickLine={false} axisLine={false} minTickGap={26} />
                <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.42)' }} tickLine={false} axisLine={false} width={46} tickFormatter={(value) => `$${value}`} />
                <Tooltip content={<GlassTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.22)' }} />
                <Area className="dd-area-daily" type="monotone" dataKey="spend" name="Spend" stroke={REVENUE_COLOR} strokeWidth={2} fill="url(#ddDailyGrad)" dot={false} activeDot={{ r: 4, fill: REVENUE_COLOR, stroke: '#0b1a35', strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {status === 'ready' && data && data.errors.length > 0 && (
        <p className="dd-fine" title={data.errors.join('\n')}>
          Some sources didn&rsquo;t load — hover for details.
        </p>
      )}
    </section>
  );
}
