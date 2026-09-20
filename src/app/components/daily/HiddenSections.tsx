import { useEffect, useRef, useState } from 'react';
import { EyeOff, Plus } from 'lucide-react';
import { topicLabel } from './newsTopics';

interface Props {
  // Ids of the hidden sections, in the order to list them.
  hidden: string[];
  onShow: (id: string) => void;
  onShowAll: () => void;
}

// Only there while something is hidden: a small list for bringing sections back.
export default function HiddenSections({ hidden, onShow, onShowAll }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => {
    if (hidden.length === 0) setOpen(false);
  }, [hidden.length]);

  if (hidden.length === 0) return null;

  const onKey = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };

  return (
    <div className="dd-dropdown" ref={rootRef}>
      <button type="button" className="dd-drop" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} title="Sections you have hidden">
        <EyeOff size={13} />
        Hidden · {hidden.length}
      </button>
      {open && (
        <ul className="dd-menu" role="menu" aria-label="Hidden sections">
          {hidden.map((id) => (
            <li key={id} role="menuitem" tabIndex={0} aria-label={`Show ${topicLabel(id)}`} onClick={() => onShow(id)} onKeyDown={(event) => onKey(event, () => onShow(id))}>
              <span>{topicLabel(id)}</span>
              <Plus size={12} />
            </li>
          ))}
          {hidden.length > 1 && (
            <li
              role="menuitem"
              tabIndex={0}
              className="dd-menu-all"
              onClick={() => {
                onShowAll();
                setOpen(false);
              }}
              onKeyDown={(event) =>
                onKey(event, () => {
                  onShowAll();
                  setOpen(false);
                })
              }
            >
              <span>Show all</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
