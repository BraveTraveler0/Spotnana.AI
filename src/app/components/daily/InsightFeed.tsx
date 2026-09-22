import { useState } from 'react';
import { BarChart3, Check, Plus, Sparkles, X } from 'lucide-react';
import { isActionable, type Post, type PostKind } from './insights';

interface Props {
  posts: Post[];
  // When Iris last wrote the feed; the posts are stamped with how long ago that was.
  updated: string;
  isAdded: (post: Post) => boolean;
  onAddTask: (post: Post) => void;
  onDismiss: (post: Post) => void;
  // How many are dismissed right now, and how to bring them back.
  dismissed: number;
  onRestore: () => void;
}

const VISIBLE = 5;

const KIND_LABEL: Record<PostKind, string> = {
  suggestion: 'Suggestion',
  drift: 'Drift',
  insight: 'Insight',
  win: 'Win',
  opportunity: 'Opportunity',
  decision: 'Decision',
};

// "3h", "2d": short, the way a feed stamps its posts.
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'this week';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// What Iris and Inana have to say about what happens next, as a feed of short
// posts: what to do, what has slipped, what was learned, what went well. Each one
// can be put on the task list or dismissed.
export default function InsightFeed({ posts, updated, isAdded, onAddTask, onDismiss, dismissed, onRestore }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [settling, setSettling] = useState<Set<string>>(new Set());
  const shown = showAll ? posts : posts.slice(0, VISIBLE);
  const stamp = timeAgo(updated);
  // Dominus's rule: adding to tasks is the end of the card's life here — it
  // fades and collapses (the task lives in Next now, not in this feed).
  const handleAdd = (post: Post) => {
    setSettling((prev) => new Set(prev).add(post.id));
    onAddTask(post);
    window.setTimeout(() => {
      setSettling((prev) => { const next = new Set(prev); next.delete(post.id); return next; });
      onDismiss(post);
    }, 700);
  };

  return (
    <section className="dd-section">
      <div className="dd-section-head dd-head-center">
        <h2 className="dd-section-title">Insights</h2>
      </div>
      <div className="dd-card">
        {shown.length === 0 && <p className="dd-fine dd-feed-empty">All dismissed.</p>}
        <ol className="dd-feed">
          {shown.map((post) => {
            const added = isAdded(post);
            return (
              <li className={`dd-post${settling.has(post.id) ? ' dd-post-settling' : ''}`} key={post.id}>
                <span className={`dd-avatar dd-avatar-${post.author.toLowerCase()}`} aria-hidden>
                  {post.author.toLowerCase() === 'iris' ? <Sparkles size={15} /> : <BarChart3 size={15} />}
                </span>
                <div className="dd-post-body">
                  <div className="dd-post-head">
                    {post.author.toLowerCase() !== 'iris' && <strong>{post.author}</strong>}
                    <span className="dd-post-time">{stamp}</span>
                    <span className={`dd-kind dd-kind-${post.kind}`}>{KIND_LABEL[post.kind]}</span>
                    <button type="button" className="dd-post-dismiss" onClick={() => onDismiss(post)} aria-label="Dismiss this insight" title="Dismiss">
                      <X size={13} />
                    </button>
                  </div>
                  {post.lead && <p className="dd-post-lead">{post.lead}</p>}
                  <p>{post.text}</p>
                  {isActionable(post) && (
                    <button type="button" className="dd-post-action" disabled={added} onClick={() => handleAdd(post)}>
                      {added ? <Check size={12} /> : <Plus size={12} />}
                      {added ? 'Added to tasks' : 'Add to tasks'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="dd-feed-foot">
        {posts.length > VISIBLE && (
          <button type="button" className="dd-link" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Show fewer' : `Show ${posts.length - VISIBLE} more`}
          </button>
        )}
        {dismissed > 0 && (
          <button type="button" className="dd-link" onClick={onRestore}>
            {dismissed} dismissed · Restore
          </button>
        )}
      </div>
    </section>
  );
}
