import { useEffect, useRef, useState } from 'react';
import { AlignLeft, CalendarDays, Clock } from 'lucide-react';

export interface NewTask {
  label: string;
  note: string;
  // "YYYY-MM-DD", "YYYY-MM-DDTHH:MM" (local time), or null for no day.
  when: string | null;
}

const pad = (value: number) => String(value).padStart(2, '0');

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface Props {
  onCreate: (task: NewTask) => void;
  onClose: () => void;
}

// A new task, laid out like creating an event in Google Calendar: a title, the
// day (today unless you change it) and an optional time, and a description.
// Because the day defaults to today, a new task lands under Today in the list
// where you can see it, instead of at the bottom.
export default function NewTaskForm({ onCreate, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayKey);
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      // The "Add a task" row that opens this form toggles it itself.
      if (target instanceof Element && target.closest('.dd-add-task')) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  const save = () => {
    const label = title.trim();
    if (!label) return;
    onCreate({ label, note: note.trim(), when: date ? (time ? `${date}T${time}` : date) : null });
  };

  return (
    <div className="dd-newtask" role="dialog" aria-label="New task" ref={rootRef}>
      <input
        className="dd-newtask-title"
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
        }}
        placeholder="Add title"
        aria-label="Title"
      />
      <div className="dd-newtask-row">
        <CalendarDays size={15} />
        <input type="date" className="dd-newtask-field" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Day" />
      </div>
      <div className="dd-newtask-row">
        <Clock size={15} />
        <input type="time" className="dd-newtask-field" value={time} onChange={(event) => setTime(event.target.value)} aria-label="Time (optional)" />
      </div>
      <div className="dd-newtask-row">
        <AlignLeft size={15} />
        <textarea className="dd-newtask-field dd-newtask-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add description" aria-label="Description" />
      </div>
      <div className="dd-newtask-actions">
        <button type="button" className="dd-link" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="dd-newtask-save" onClick={save} disabled={!title.trim()}>
          Save
        </button>
      </div>
    </div>
  );
}
