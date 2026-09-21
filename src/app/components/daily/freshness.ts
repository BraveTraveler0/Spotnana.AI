// Which task tabs have something the user hasn't looked at yet. The count on a tab is
// only highlighted while that is true; otherwise it is just a number.

export type WatchedTab = 'next' | 'suggested';
export const WATCHED_TABS: WatchedTab[] = ['next', 'suggested'];

// What has been seen on each tab, by item key. A tab that has never had anything
// on it has no entry.
export type SeenState = Partial<Record<WatchedTab, string[]>>;
export type TabKeys = Record<WatchedTab, string[]>;

// Enough to remember what has come and gone lately, not forever.
const MAX_KEPT = 400;

// What is seen after the tab on screen has been looked at. A tab's first items are
// taken as already known, so an update doesn't light every badge at once; after
// that, whatever is on the tab you are viewing counts as seen. Returns the same
// object when nothing changed.
export function updateSeen(seen: SeenState, keys: TabKeys, active: string): SeenState {
  let next = seen;
  for (const tab of WATCHED_TABS) {
    const current = keys[tab];
    const known = seen[tab];
    const firstItems = known === undefined && current.length > 0;
    const viewedNew = tab === active && known !== undefined && current.some((key) => !known.includes(key));
    if (firstItems || viewedNew) {
      next = { ...next, [tab]: [...new Set([...(known ?? []), ...current])].slice(-MAX_KEPT) };
    }
  }
  return next;
}

// A tab is fresh when it holds something not yet seen and is not the tab on screen.
export function freshTabs(seen: SeenState, keys: TabKeys, active: string): Record<WatchedTab, boolean> {
  const fresh = (tab: WatchedTab) => {
    const known = seen[tab];
    return tab !== active && known !== undefined && keys[tab].some((key) => !known.includes(key));
  };
  return { next: fresh('next'), suggested: fresh('suggested') };
}
