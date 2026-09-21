import { useEffect, useMemo, useState } from 'react';
import { freshTabs, updateSeen, type SeenState, type TabKeys } from './freshness';

const KEY = 'artemis.daily.seenItems';

function load(): SeenState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as SeenState;
    const clean = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : undefined);
    return { next: clean(parsed.next), suggested: clean(parsed.suggested) };
  } catch {
    return {};
  }
}

function save(seen: SeenState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    /* storage unavailable: everything just counts as new again next time */
  }
}

// Which of the task tabs have something you haven't looked at yet. What you have
// looked at is remembered on this machine, so a restart doesn't make it all new.
export function useFreshTabs(active: string, keys: TabKeys) {
  const [seen, setSeen] = useState(load);
  const signature = `${keys.next.join('\n')}\u0000${keys.suggested.join('\n')}`;

  useEffect(() => {
    setSeen((previous) => {
      const next = updateSeen(previous, keys, active);
      if (next !== previous) save(next);
      return next;
    });
    // `keys` is rebuilt every render; its contents are what `signature` tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, signature]);

  return useMemo(() => freshTabs(seen, keys, active), [seen, signature, active]); // eslint-disable-line react-hooks/exhaustive-deps
}
