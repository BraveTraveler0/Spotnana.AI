import { useCallback, useState } from 'react';

const STORAGE_KEY = 'artemis-daily-hidden-news';

function load(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(hidden: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
  } catch {
    /* storage unavailable: the choice just won't outlive this session */
  }
}

// Which news sections the user has hidden (by topic id), remembered on this machine.
export function useHiddenTopics() {
  const [hidden, setHidden] = useState(load);

  const hide = useCallback((id: string) => {
    setHidden((previous) => {
      const next = new Set(previous).add(id);
      save(next);
      return next;
    });
  }, []);

  const show = useCallback((id: string) => {
    setHidden((previous) => {
      const next = new Set(previous);
      next.delete(id);
      save(next);
      return next;
    });
  }, []);

  const showAll = useCallback(() => {
    const next = new Set<string>();
    save(next);
    setHidden(next);
  }, []);

  return { hidden, hide, show, showAll };
}
