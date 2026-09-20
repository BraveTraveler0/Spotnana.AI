import { useCallback, useState } from 'react';
import type { Post } from './insights';

const KEY = 'artemis.daily.handledInsights';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export type PostChoice = 'added' | 'dismissed';

interface Entry {
  at: number;
  choice: PostChoice;
}

// Keyed by what a post says as well as its id, so an insight Iris rewrites comes
// back as a new card instead of staying dismissed.
export const postKey = (post: Post) => `${post.id}::${post.text}`;

function load(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Entry>;
    const cutoff = Date.now() - KEEP_MS;
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => entry && entry.at > cutoff && (entry.choice === 'added' || entry.choice === 'dismissed')));
  } catch {
    return {};
  }
}

function save(entries: Record<string, Entry>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage unavailable: the choice just won't outlive this session */
  }
}

// What you did with each insight: put it on your task list, or turned it away.
// Iris owns the feed, so this is remembered on this machine, and an insight you
// added stays marked as added instead of inviting a second copy after a restart.
export function useHandledPosts() {
  const [choices, setChoices] = useState(load);

  const choose = useCallback((post: Post, choice: PostChoice) => {
    const at = Date.now();
    setChoices((previous) => {
      const next = { ...previous, [postKey(post)]: { at, choice } };
      save(next);
      return next;
    });
  }, []);

  // Brings every dismissed insight back (the ones added to tasks stay added).
  const restore = useCallback(() => {
    setChoices((previous) => {
      const next = Object.fromEntries(Object.entries(previous).filter(([, entry]) => entry.choice !== 'dismissed'));
      save(next);
      return next;
    });
  }, []);

  return { choices, choose, restore };
}
