import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Plus, X } from 'lucide-react';
import type { TasteRec } from './types';

// Kind → the small all-caps tag on the card. Unknown kinds show as written.
const KIND_LABELS: Record<string, string> = {
  restaurant: 'Restaurant',
  'wine-bar': 'Wine bar',
  brewery: 'Brewery',
  recipe: 'Recipe',
  cafe: 'Café',
};

function recKind(rec: TasteRec): string {
  const kind = (rec.kind ?? '').trim().toLowerCase();
  return KIND_LABELS[kind] ?? (kind || 'Place');
}

// Choices about recs are remembered on this machine (the feed is Iris's to
// write): a dismissed rec stays gone and an added one keeps its mark for a
// month, like the handled task cards.
const DISMISSED_KEY = 'artemis.daily.tasteDismissed';
const ADDED_KEY = 'artemis.daily.tasteAdded';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

function rememberedIds(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>;
    const cutoff = Date.now() - KEEP_MS;
    return new Set(Object.entries(parsed).filter(([, at]) => at > cutoff).map(([id]) => id));
  } catch {
    return new Set();
  }
}

function rememberId(key: string, id: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>;
    parsed[id] = Date.now();
    localStorage.setItem(key, JSON.stringify(parsed));
  } catch {
    /* storage unavailable: the choice just won't outlive this session */
  }
}

interface ShelfProps {
  title: string;
  recs: TasteRec[];
  added: Set<string>;
  adding: string | null;
  broken: Set<string>;
  onOpenLink: (url: string) => void;
  onDismiss: (rec: TasteRec) => void;
  onAdd: (rec: TasteRec) => void;
  onBroken: (image: string) => void;
}

// One scrolling row of rec cards under its own heading, with the pair of round
// arrows and the + / × on every card.
function RecShelf({ title, recs, added, adding, broken, onOpenLink, onDismiss, onAdd, onBroken }: ShelfProps) {
  const rowRef = useRef<HTMLUListElement>(null);

  const scroll = (dir: 1 | -1) => {
    const row = rowRef.current;
    if (row) row.scrollBy({ left: dir * Math.max(row.clientWidth * 0.8, 220), behavior: 'smooth' });
  };

  return (
    <div className="dd-taste">
      <div className="dd-taste-head">
        <h2 className="dd-taste-label">{title}</h2>
        <span className="dd-taste-arrows">
          <button type="button" className="dd-taste-arrow" onClick={() => scroll(-1)} aria-label="Scroll back" title="Scroll back">
            <ChevronLeft size={14} />
          </button>
          <button type="button" className="dd-taste-arrow" onClick={() => scroll(1)} aria-label="Scroll forward" title="Scroll forward">
            <ChevronRight size={14} />
          </button>
        </span>
      </div>
      <ul className="dd-taste-row" ref={rowRef}>
        {recs.map((rec) => {
          const meta = [recKind(rec), rec.area].filter(Boolean).join(' · ');
          const isAdded = added.has(rec.id);
          return (
            <li key={rec.id} className="dd-taste-card">
              {rec.image && !broken.has(rec.image) && (
                <img
                  className="dd-taste-pic"
                  src={rec.image}
                  alt=""
                  loading="lazy"
                  onError={() => {
                    // A dead picture must not leave an empty broken box: drop it
                    // and the card falls back to its plain form.
                    onBroken(rec.image as string);
                  }}
                />
              )}
              <span className="dd-taste-kind">{meta}</span>
              {rec.link ? (
                <button type="button" className="dd-taste-name dd-task-titlelink" onClick={() => onOpenLink(rec.link as string)} title="Open the details">
                  {rec.name}
                  <ExternalLink size={11} className="dd-taste-ext" />
                </button>
              ) : (
                <span className="dd-taste-name">{rec.name}</span>
              )}
              {rec.note && <span className="dd-taste-note">{rec.note}</span>}
              {(rec.rating || rec.kind === 'recipe') && (
                <span className="dd-taste-meta">{rec.rating ? `${rec.rating} ★` : 'To cook'}</span>
              )}
              {isAdded ? (
                <span className="dd-taste-added">On your list</span>
              ) : (
                <>
                  <button
                    type="button"
                    className="dd-taste-x"
                    onClick={() => onDismiss(rec)}
                    aria-label={`Not interested in "${rec.name}"`}
                    title="Not for me"
                  >
                    <X size={12} />
                  </button>
                  <button
                    type="button"
                    className="dd-taste-add"
                    onClick={() => onAdd(rec)}
                    disabled={adding === rec.id}
                    aria-label={`Add "${rec.name}" to your list`}
                    title="Add to your list"
                  >
                    <Plus size={12} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The Taste shelves, at the bottom of the Daily middle column: two lists —
// restaurants/bars/cafés to try, and recipes to cook — each a horizontally
// scrolling row. Iris writes the recs (iris-feed/TASKS-CONTRACT.md "recs"); a
// rating is shown only when Iris actually found one. The + puts one on your
// list (under Anytime: these have no day of their own) and the × turns it down
// for good, the same pair the suggested cards carry.
export default function TasteStrip({
  recs,
  onOpenLink,
  onAddRec,
}: {
  recs: TasteRec[];
  onOpenLink: (url: string) => void;
  onAddRec: (rec: TasteRec) => Promise<boolean>;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => rememberedIds(DISMISSED_KEY));
  const [added, setAdded] = useState<Set<string>>(() => rememberedIds(ADDED_KEY));
  const [adding, setAdding] = useState<string | null>(null);
  // Pictures that failed to load stop rendering (no broken-image box); plain
  // cards were fine before, so the fallback is just "no picture".
  const [broken, setBroken] = useState<Set<string>>(() => new Set());

  const places = recs.filter((rec) => (rec.kind ?? '').trim().toLowerCase() !== 'recipe' && !dismissed.has(rec.id));
  const recipes = recs.filter((rec) => (rec.kind ?? '').trim().toLowerCase() === 'recipe' && !dismissed.has(rec.id));
  if (places.length === 0 && recipes.length === 0) return null;

  const dismiss = (rec: TasteRec) => {
    rememberId(DISMISSED_KEY, rec.id);
    setDismissed((previous) => new Set(previous).add(rec.id));
  };

  const add = async (rec: TasteRec) => {
    if (added.has(rec.id) || adding) return;
    setAdding(rec.id);
    const ok = await onAddRec(rec);
    setAdding(null);
    // Only marked when the task really saved, so a failed add can be retried.
    if (ok) {
      rememberId(ADDED_KEY, rec.id);
      setAdded((previous) => new Set(previous).add(rec.id));
    }
  };

  const reportBroken = (image: string) => setBroken((previous) => new Set(previous).add(image));

  return (
    <>
      {places.length > 0 && (
        <RecShelf title="Restaurants & bars" recs={places} added={added} adding={adding} broken={broken} onOpenLink={onOpenLink} onDismiss={dismiss} onAdd={(rec) => void add(rec)} onBroken={reportBroken} />
      )}
      {recipes.length > 0 && (
        <RecShelf title="Cooking" recs={recipes} added={added} adding={adding} broken={broken} onOpenLink={onOpenLink} onDismiss={dismiss} onAdd={(rec) => void add(rec)} onBroken={reportBroken} />
      )}
    </>
  );
}