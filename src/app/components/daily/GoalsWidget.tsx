import { useMemo, useState } from 'react';
import { ArrowUpRight, Loader2, Minus, Plus, Sparkles } from 'lucide-react';
import DropdownSelect, { type DropdownOption } from './DropdownSelect';
import type { GoalItem, GoalSection, WeeklyGoal, WeeklyGoals } from './types';
import type { GoalTaps } from './useGoalTaps';

type GroupItem = GoalItem & { section: string };
type Period = 'weekly' | 'monthly' | 'yearly';

interface Props {
  sections: GoalSection[];
  // Iris's weekly goals; null until the first read.
  weekly: WeeklyGoals | null;
  // The + and − on each weekly goal: what the ring shows, and how a rep is logged or taken back.
  taps: GoalTaps;
  error: string;
  loaded: boolean;
  breakingDown: Set<string>;
  onToggle: (itemId: string, currentlyDone: boolean) => void;
  onBreakDown: (sectionTitle: string, itemId: string, itemText: string) => void;
  onOpenGoals: () => void;
  onStartSession: (prompt: string) => void;
}

const PERIOD_STORAGE_KEY = 'artemis-daily-goal-period';
const PERIODS: DropdownOption[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];
const VISIBLE_GOALS = 8;
// The list column scrolls beside the ring, so the cap here just bounds the DOM, not the view.
const VISIBLE_RECURRING = 12;
// Up to this many reps a goal shows as one pip each; past it, as a bar.
const MAX_PIPS = 7;
const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function readSavedPeriod(): Period | '' {
  try {
    const saved = localStorage.getItem(PERIOD_STORAGE_KEY);
    return saved === 'weekly' || saved === 'monthly' || saved === 'yearly' ? saved : '';
  } catch {
    return '';
  }
}

function savePeriod(value: Period | '') {
  try {
    if (value) localStorage.setItem(PERIOD_STORAGE_KEY, value);
    else localStorage.removeItem(PERIOD_STORAGE_KEY);
  } catch {
    /* storage unavailable — the choice just won't persist */
  }
}

interface RecurringRow {
  id: string;
  title: string;
  category: string;
  done: number;
  target: number;
  goal: WeeklyGoal;
  // A rep can only be taken back if this week has one (the monthly count includes earlier weeks).
  canTakeOff: boolean;
}

// Weekly and monthly are the same goals of Iris's, counted over the calendar
// week or month; yearly is this year's part of Goals.md (the long-horizon
// topics live on the Goals tab).
export default function GoalsWidget({ sections, weekly, taps, error, loaded, breakingDown, onToggle, onBreakDown, onOpenGoals, onStartSession }: Props) {
  const groups = useMemo(() => {
    const order: string[] = [];
    const byName = new Map<string, GroupItem[]>();
    for (const section of sections) {
      const name = section.group || section.title;
      if (!byName.has(name)) {
        byName.set(name, []);
        order.push(name);
      }
      byName.get(name)!.push(...section.items.map((item) => ({ ...item, section: section.title })));
    }
    return order.map((name) => ({ name, items: byName.get(name)! }));
  }, [sections]);

  const weeklyGoals = weekly?.goals ?? [];
  const hasWeekly = weeklyGoals.length > 0;

  // This week's goals lead whenever there are any, and yearly otherwise. Only a
  // choice that differs from that is remembered, so the default keeps following
  // what exists (weekly goals appearing later still lead).
  const defaultPeriod: Period = hasWeekly ? 'weekly' : 'yearly';
  const [selected, setSelected] = useState<Period | ''>(readSavedPeriod);
  const period: Period = selected || defaultPeriod;
  const recurring = period !== 'yearly';

  const choose = (value: string) => {
    const next: Period | '' = value === defaultPeriod ? '' : (value as Period);
    setSelected(next);
    savePeriod(next);
  };

  const yearGroup = useMemo(() => {
    const year = String(new Date().getFullYear());
    return groups.find((group) => group.name.startsWith(year)) ?? groups.find((group) => group.items.some((item) => !item.done)) ?? groups[0];
  }, [groups]);

  const yearTotal = yearGroup?.items.length ?? 0;
  const yearDone = yearGroup?.items.filter((item) => item.done).length ?? 0;
  const yearVisible = (yearGroup?.items.filter((item) => !item.done) ?? []).slice(0, VISIBLE_GOALS);

  const rows: RecurringRow[] = weeklyGoals.map((goal) => ({
    id: goal.id,
    title: goal.title,
    category: goal.category,
    done: period === 'monthly' ? taps.monthDone(goal) : taps.weekDone(goal),
    target: period === 'monthly' ? goal.month_target : goal.target,
    goal,
    canTakeOff: taps.weekDone(goal) >= 1,
  }));
  const repsTotal = rows.reduce((sum, row) => sum + row.target, 0);
  const repsDone = rows.reduce((sum, row) => sum + Math.min(row.done, row.target), 0);
  const visibleRows = [...rows].sort((a, b) => Number(a.done >= a.target) - Number(b.done >= b.target)).slice(0, VISIBLE_RECURRING);

  const ringDone = recurring ? repsDone : yearDone;
  const ringTotal = recurring ? repsTotal : yearTotal;
  const percent = ringTotal > 0 ? Math.round((ringDone / ringTotal) * 100) : 0;
  const span = period === 'monthly' ? 'month' : 'week';

  return (
    <section className="dd-section dd-goals-section">
      <div className="dd-section-head">
        <h2 className="dd-section-title">Goals</h2>
        <div className="dd-insight-tools">
          <DropdownSelect value={period} options={PERIODS} onChange={choose} ariaLabel="Goal period" />
          {recurring ? (
            <button type="button" className="dd-link" onClick={() => onStartSession('Update my weekly goals: ')} title="Add, remove or change goals by telling Iris in chat">
              Edit with Iris <ArrowUpRight size={12} />
            </button>
          ) : (
            <button type="button" className="dd-link" onClick={onOpenGoals}>
              All goals <ArrowUpRight size={12} />
            </button>
          )}
        </div>
      </div>

      {!recurring && error && <p className="dd-fine">{error}</p>}
      {!recurring && !error && !loaded && <p className="dd-fine">Loading goals…</p>}
      {!recurring && !error && loaded && yearTotal === 0 && <p className="dd-fine">No goals found for this year.</p>}

      {ringTotal > 0 && (
        <div className="dd-goals">
          <div
            className="dd-ring"
            role="img"
            aria-label={recurring ? `${percent} percent of this ${span}'s goals done` : `${percent} percent of ${yearGroup?.name ?? 'this year'}'s goals done`}
          >
            <svg viewBox="0 0 124 124">
              <circle className="dd-ring-inner" cx="62" cy="62" r="41" />
              <circle className="dd-ring-track" cx="62" cy="62" r={RING_RADIUS} />
              <circle
                className="dd-ring-progress"
                cx="62"
                cy="62"
                r={RING_RADIUS}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
              />
            </svg>
            <span className="dd-ring-value">{percent}%</span>
            <span className="dd-ring-sub">
              {ringDone}/{ringTotal}
            </span>
          </div>

          <div className="dd-goal-rows">
            {recurring
              ? visibleRows.map((row) => {
                  const complete = row.done >= row.target;
                  return (
                    <div className="dd-goal-row" key={row.id}>
                      <div className="dd-goal-tile">
                        <div className="dd-goal-main">
                          <button
                            type="button"
                            className="dd-goal-label"
                            onClick={() => onStartSession(`I just did my weekly goal "${row.title}". Log it for today.`)}
                            title="Log a rep by telling Iris"
                          >
                            <i className={`dd-goal-dot ${complete ? '' : 'open'}`} />
                            <span>{row.title}</span>
                          </button>
                          <div className="dd-goal-meta">
                            <span>{complete ? `Done for the ${span}` : `${row.target - row.done} to go`}</span>
                            {row.target <= MAX_PIPS ? (
                              <span className="dd-pips" aria-hidden>
                                {Array.from({ length: row.target }, (_, index) => (
                                  <i key={index} className={index < row.done ? 'on' : ''} />
                                ))}
                              </span>
                            ) : (
                              <span className="dd-bar" aria-hidden>
                                <i style={{ width: `${Math.min(100, Math.round((row.done / row.target) * 100))}%` }} />
                              </span>
                            )}
                            <em>
                              {row.done}/{row.target}
                              {row.category && row.category !== 'other' ? ` · ${row.category}` : ''}
                            </em>
                          </div>
                        </div>
                        <div className="dd-goal-steps">
                          <button
                            type="button"
                            className={`dd-goal-step ${row.canTakeOff ? '' : 'is-hidden'}`}
                            onClick={() => taps.log(row.goal, -1)}
                            disabled={!row.canTakeOff}
                            tabIndex={row.canTakeOff ? 0 : -1}
                            aria-hidden={!row.canTakeOff}
                            aria-label={`Take one off "${row.title}"`}
                            title="Take one off, if you logged it by mistake"
                          >
                            <Minus size={13} />
                          </button>
                          <button type="button" className="dd-goal-step" onClick={() => taps.log(row.goal, 1)} aria-label={`I did "${row.title}" once`} title="I did one">
                            <Plus size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              : (
                <>
                  {yearVisible.length === 0 && <p className="dd-fine">Everything for {yearGroup?.name} is done. Nicely played.</p>}
                  {yearVisible.map((item) => {
                    const nextStep = item.sub_steps.find((step) => !step.done);
                    const stepsDone = item.sub_steps.filter((step) => step.done).length;
                    const isBreaking = breakingDown.has(item.id);
                    return (
                      <div className="dd-goal-row" key={item.id}>
                        <button type="button" className="dd-goal-label" onClick={() => onToggle(item.id, item.done)} aria-label={`Mark "${item.text}" as done`} title="Mark as done">
                          <i className="dd-goal-dot" />
                          <span>{item.text}</span>
                        </button>
                        {nextStep ? (
                          <button
                            type="button"
                            className="dd-goal-card"
                            onClick={() => onStartSession(`Let's work on my goal: "${item.text}". My next step is: ${nextStep.text}. Help me get started.`)}
                            title="Start a chat about this goal"
                          >
                            <span>{nextStep.text}</span>
                            <em>
                              Step {stepsDone + 1} of {item.sub_steps.length}
                            </em>
                          </button>
                        ) : (
                          <button type="button" className="dd-goal-card dd-goal-card-ghost" disabled={isBreaking} onClick={() => onBreakDown(item.section, item.id, item.text)}>
                            {isBreaking ? (
                              <>
                                <Loader2 size={13} className="dd-spin" /> Planning steps…
                              </>
                            ) : (
                              <>
                                <Sparkles size={13} /> Break it down
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
          </div>
        </div>
      )}

      {recurring && taps.error && <p className="dd-fine dd-goal-note">{taps.error}</p>}

      {weekly && !hasWeekly && (
        <div className="dd-goals-hint">
          <p className="dd-fine">{weekly.exists ? 'Your weekly goals list is empty.' : 'No weekly goals yet.'} Tell Iris what you want to do each week and this ring will track it.</p>
          <button type="button" className="dd-link" onClick={() => onStartSession('Add a weekly goal: ')}>
            <Plus size={12} /> Add a weekly goal
          </button>
        </div>
      )}
    </section>
  );
}
