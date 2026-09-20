import { Fragment, useState, type ReactNode } from 'react';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import { agendaFor, agendaForTask, dayLabel, groupByDay, localDay, type Agenda } from './agenda';
import { cardKey, type FinishedEntry } from './finished';
import NewTaskForm, { type NewTask } from './NewTaskForm';
import type { DailyTask, IrisTaskCard, ScheduledTaskInfo } from './types';
import type { ScoutState } from './useIrisCards';

interface IrisSuggestion {
  text: string;
  needsAnswer: boolean;
  answered: boolean;
  responding: boolean;
}

interface Props {
  // The user's own tasks (typed in, or added from chat).
  tasks: DailyTask[];
  scheduled: ScheduledTaskInfo[];
  // Iris's cards, already minus anything dismissed, accepted or finished.
  nextCards: IrisTaskCard[];
  pendingCards: IrisTaskCard[];
  suggestedCards: IrisTaskCard[];
  // Cards checked off this week, newest first.
  finishedCards: FinishedEntry[];
  irisSuggestion: IrisSuggestion | null;
  accepting: Set<string>;
  notice: string;
  scout: { state: ScoutState; error: string };
  onAdd: (task: NewTask) => void;
  onToggle: (id: string, currentlyDone: boolean) => void;
  onRemove: (id: string) => void;
  onCancelScheduled: (id: string) => void;
  onIrisAnswer: (answer: 'yes' | 'no') => void;
  onAcceptCard: (card: IrisTaskCard) => void;
  onDismissCard: (card: IrisTaskCard) => void;
  onCompleteCard: (card: IrisTaskCard) => void;
  onUndoFinished: (entry: FinishedEntry) => void;
  onOpenLink: (url: string) => void;
  onAskScout: () => void;
}

type Tab = 'next' | 'suggested' | 'done';

const SOURCE_LABELS: Record<string, string> = {
  calendar: 'Calendar',
  goal: 'Weekly goal',
  committed: 'You said',
};

// Returns AREA · COST · CATEGORY pieces (all-caps, empty pieces dropped).
function areaCostCategory(card: IrisTaskCard): string {
  // Area lives on the time line now; the meta keeps cost + category.
  return [
    card.cost?.trim().toUpperCase(),
    card.category && card.category !== 'other' ? card.category.toUpperCase() : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function cardMeta(card: IrisTaskCard): string {
  // iris/scout: provenance is noise — area/cost/category only.
  if (card.source === 'iris' || card.source === 'scout') {
    return areaCostCategory(card);
  }
  // calendar/committed/goal/routine: keep the distinguishing label, then area/cost/category.
  const label = SOURCE_LABELS[card.source] ?? card.source;
  const detail = areaCostCategory(card);
  return [label, detail].filter(Boolean).join(' · ');
}

// Truncate to the first sentence (ends at .!?); appends … only when there is more.
function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]*[.!?]/);
  if (!match) return text;
  const first = match[0].trim();
  return text.trim() === first ? text : `${first}…`;
}

// "Today · 12:31 PM", "Saturday · 4:05 PM": when a card was checked off.
function finishedStamp(at: number): string {
  const date = new Date(at);
  return `${dayLabel(localDay(date)).name} · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

interface CardProps {
  card: IrisTaskCard;
  // Where the card sits on the agenda: its time, and its description with the
  // day and time left out (the separator above it says the day).
  agenda: Agenda;
  // Only suggested cards can be acted on: the + takes one on and the x turns it
  // down. Next cards come from the calendar and Iris, so there is nothing to dismiss;
  // they can be checked off instead.
  suggested?: boolean;
  pending?: boolean;
  busy?: boolean;
  onAccept: (card: IrisTaskCard) => void;
  onDismiss: (card: IrisTaskCard) => void;
  // Given for a card that can be checked off.
  onComplete?: (card: IrisTaskCard) => void;
  onOpenLink: (url: string) => void;
}

function IrisCard({ card, agenda, suggested, pending, busy, onAccept, onDismiss, onComplete, onOpenLink }: CardProps) {
  // For suggested cards that carry area/cost, clip the conversational 'why' to one sentence.
  const displayDescription =
    suggested && (card.area || card.cost) && agenda.description ? firstSentence(agenda.description) : agenda.description;
  return (
    <li className={`dd-task dd-iris-card ${suggested ? 'dd-suggestion dd-has-dismiss' : ''}`}>
      {onComplete && (
        <button
          type="button"
          className="dd-check"
          onClick={() => onComplete(card)}
          aria-label={`Mark "${card.title}" as done`}
          title={card.goal_id ? 'Mark as done. Iris is told.' : 'Mark as done'}
        />
      )}
      <div className="dd-task-main">
        {agenda.time && (
          <span className="dd-task-time">
            {agenda.time}
            {card.area?.trim() ? ` · ${card.area.trim()}` : ''}
          </span>
        )}
        {card.link ? (
          <button type="button" className="dd-task-title dd-task-titlelink" onClick={() => onOpenLink(card.link as string)} title="Open the details">
            {card.title}
          </button>
        ) : (
          <span className="dd-task-title">{card.title}</span>
        )}
        {displayDescription && <span className="dd-task-detail">{displayDescription}</span>}
        {pending && <span className="dd-task-note">Sent to Iris. She&rsquo;ll put it on your list.</span>}
        <span className="dd-task-source">{cardMeta(card)}</span>
      </div>
      {suggested && (
        <button type="button" className="dd-task-dismiss" onClick={() => onDismiss(card)} aria-label={`Dismiss "${card.title}"`} title="Not for me">
          <X size={13} />
        </button>
      )}
      {suggested && card.action !== 'dismiss' && (
        <button type="button" className="dd-suggest-add" onClick={() => onAccept(card)} disabled={busy} aria-label={`Add "${card.title}" to Next`} title="Add to Next">
          {busy ? <Loader2 size={11} className="dd-spin" /> : <Plus size={12} />}
        </button>
      )}
    </li>
  );
}

interface Entry {
  key: string;
  agenda: Agenda;
  node: ReactNode;
}

function DayHeader({ day }: { day: string | null }) {
  const label = day ? dayLabel(day) : { name: 'Anytime', date: '' };
  return (
    <li className="dd-agenda-day">
      <span className="dd-agenda-name">{label.name}</span>
      {label.date && <span className="dd-agenda-date">{label.date}</span>}
    </li>
  );
}

// Entries under a horizontal separator for each day, the way Google Calendar's
// schedule view lays out a week. With no dated entries there is nothing to separate.
function AgendaItems({ entries }: { entries: Entry[] }) {
  const groups = groupByDay(entries);
  const separated = groups.some((group) => group.day !== null);
  return (
    <>
      {groups.map((group) => (
        <Fragment key={group.day ?? 'anytime'}>
          {separated && <DayHeader day={group.day} />}
          {group.items.map((entry) => (
            <Fragment key={entry.key}>{entry.node}</Fragment>
          ))}
        </Fragment>
      ))}
    </>
  );
}

export default function TasksPanel({
  tasks,
  scheduled,
  nextCards,
  pendingCards,
  suggestedCards,
  finishedCards,
  irisSuggestion,
  accepting,
  notice,
  scout,
  onAdd,
  onToggle,
  onRemove,
  onCancelScheduled,
  onIrisAnswer,
  onAcceptCard,
  onDismissCard,
  onCompleteCard,
  onUndoFinished,
  onOpenLink,
  onAskScout,
}: Props) {
  const [tab, setTab] = useState<Tab>('next');
  const [creating, setCreating] = useState(false);

  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);
  const nextCount = nextCards.length + pendingCards.length + open.length;
  const suggestedCount = suggestedCards.length + (irisSuggestion ? 1 : 0);
  const doneCount = done.length + finishedCards.length;

  const create = (task: NewTask) => {
    setCreating(false);
    setTab('next');
    onAdd(task);
  };

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'next', label: 'Next', count: nextCount },
    { id: 'suggested', label: 'Suggested', count: suggestedCount },
    { id: 'done', label: 'Done', count: doneCount },
  ];

  const renderCard = (card: IrisTaskCard, agenda: Agenda, options: { suggested?: boolean; pending?: boolean } = {}) => (
    <IrisCard
      key={cardKey(card)}
      card={card}
      agenda={agenda}
      suggested={options.suggested}
      pending={options.pending}
      busy={accepting.has(cardKey(card))}
      onAccept={onAcceptCard}
      onDismiss={onDismissCard}
      onComplete={options.suggested ? undefined : onCompleteCard}
      onOpenLink={onOpenLink}
    />
  );

  // Laid out like Iris's cards (dd-iris-card), so every check circle in the list lines up.
  const renderTask = (task: DailyTask) => {
    const agenda = agendaForTask(task);
    return (
      <li key={task.id} className={`dd-task dd-iris-card ${task.done ? 'done' : ''}`}>
        <button
          type="button"
          className="dd-check"
          onClick={() => onToggle(task.id, task.done)}
          aria-label={task.done ? `Mark "${task.label}" as not done` : `Mark "${task.label}" as done`}
          aria-pressed={task.done}
        >
          {task.done && <Check size={11} strokeWidth={3} />}
        </button>
        <div className="dd-task-main">
          {agenda.time && <span className="dd-task-time">{agenda.time}</span>}
          <span className="dd-task-title">{task.label}</span>
          {agenda.description && <span className="dd-task-detail">{agenda.description}</span>}
          {task.source && <span className="dd-task-source">{task.source}</span>}
        </div>
        <button type="button" className="dd-task-remove" onClick={() => onRemove(task.id)} aria-label="Remove task" title="Remove task">
          <Trash2 size={13} />
        </button>
      </li>
    );
  };

  // A card you checked off. One that counts toward a weekly goal has been reported
  // to Iris, who keeps the count, so it can't be un-checked from here.
  const renderFinished = (entry: FinishedEntry) => (
    <li key={`${entry.at}-${cardKey(entry.card)}`} className="dd-task dd-iris-card done">
      {entry.card.goal_id ? (
        <span className="dd-check dd-check-static" aria-hidden>
          <Check size={11} strokeWidth={3} />
        </span>
      ) : (
        <button type="button" className="dd-check" onClick={() => onUndoFinished(entry)} aria-label={`Mark "${entry.card.title}" as not done`} aria-pressed>
          <Check size={11} strokeWidth={3} />
        </button>
      )}
      <div className="dd-task-main">
        <span className="dd-task-time">{finishedStamp(entry.at)}</span>
        <span className="dd-task-title">{entry.card.title}</span>
        <span className="dd-task-source">{cardMeta(entry.card)}</span>
      </div>
    </li>
  );

  const cardEntry = (card: IrisTaskCard, options: { suggested?: boolean; pending?: boolean } = {}): Entry => {
    const agenda = agendaFor(card);
    return { key: cardKey(card), agenda, node: renderCard(card, agenda, options) };
  };
  // Your own tasks go on the day you gave them, like the cards; one with no day
  // sits with the undated ones at the end.
  const nextEntries: Entry[] = [
    ...nextCards.map((card) => cardEntry(card)),
    ...pendingCards.map((card) => cardEntry(card, { pending: true })),
    ...open.map((task) => ({ key: task.id, agenda: agendaForTask(task), node: renderTask(task) })),
  ];
  const suggestedEntries = suggestedCards.map((card) => cardEntry(card, { suggested: true }));

  return (
    <>
      <section className="dd-block">
        <h2 className="dd-label">Tasks</h2>
        <div className="dd-add-task">
          <button type="button" className="dd-add-prompt" onClick={() => setCreating((value) => !value)} aria-expanded={creating}>
            Add a task
          </button>
          <button type="button" className="dd-add" onClick={() => setCreating((value) => !value)} aria-label="Add task" title="Add task">
            <Plus size={16} />
          </button>
          {creating && <NewTaskForm onCreate={create} onClose={() => setCreating(false)} />}
        </div>

        <div className="dd-tabs" role="tablist" aria-label="Task filter">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={`dd-tab ${tab === entry.id ? 'active' : ''}`} onClick={() => setTab(entry.id)}>
              {entry.label}
              {entry.count > 0 && <sup>{entry.count}</sup>}
            </button>
          ))}
        </div>

        {notice && <p className="dd-notice" role="status">{notice}</p>}

        <ul className="dd-task-list">
          {tab === 'next' &&
            (nextCount > 0 ? (
              <AgendaItems entries={nextEntries} />
            ) : (
              <li className="dd-empty-line">Nothing on your list. Add one above, or just ask.</li>
            ))}
          {tab === 'done' &&
            (doneCount > 0 ? (
              <>
                {finishedCards.map(renderFinished)}
                {done.map(renderTask)}
              </>
            ) : (
              <li className="dd-empty-line">Nothing finished yet.</li>
            ))}
          {tab === 'suggested' && (
            <>
              {irisSuggestion && (
                <li className="dd-task dd-suggestion dd-iris-suggestion">
                  <div className="dd-task-main">
                    <span className="dd-task-source">Iris suggests</span>
                    <span className="dd-task-title">{irisSuggestion.text}</span>
                    {irisSuggestion.needsAnswer && !irisSuggestion.answered ? (
                      <span className="dd-yesno">
                        <button type="button" className="dd-answer no" disabled={irisSuggestion.responding} onClick={() => onIrisAnswer('no')} aria-label="No" title="No">
                          <X size={17} />
                        </button>
                        <button type="button" className="dd-answer yes" disabled={irisSuggestion.responding} onClick={() => onIrisAnswer('yes')} aria-label="Yes" title="Yes">
                          <Check size={17} strokeWidth={2.5} />
                        </button>
                      </span>
                    ) : irisSuggestion.answered ? (
                      <span className="dd-task-note">Sent to Iris.</span>
                    ) : null}
                  </div>
                </li>
              )}
              <AgendaItems entries={suggestedEntries} />
              {suggestedCount === 0 && (
                <li className="dd-empty-line">
                  <p>No suggestions right now. Iris scouts local events every Monday morning.</p>
                  {scout.state === 'asked' ? (
                    <p className="dd-scout-note">Asked Iris. New ones show up here when she&rsquo;s done.</p>
                  ) : (
                    <button type="button" className="dd-link" onClick={onAskScout} disabled={scout.state === 'sending'}>
                      {scout.state === 'sending' ? 'Asking Iris…' : 'Ask Iris to look now'}
                    </button>
                  )}
                  {scout.error && <p className="dd-scout-note dd-scout-error">{scout.error}</p>}
                </li>
              )}
            </>
          )}
        </ul>

        {scheduled.length > 0 && (
          <details className="dd-scheduled">
            <summary>Scheduled · {scheduled.length}</summary>
            <ul>
              {scheduled.map((task) => (
                <li key={task.id}>
                  <div>
                    <span>{task.title}</span>
                    <em>
                      Daily at {String(task.hour).padStart(2, '0')}:{String(task.minute).padStart(2, '0')}
                    </em>
                  </div>
                  <button type="button" className="dd-task-remove" onClick={() => onCancelScheduled(task.id)} aria-label="Cancel scheduled task" title="Cancel scheduled task">
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}
