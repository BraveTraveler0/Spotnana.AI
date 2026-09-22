import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { addTap, readTaps, saveTaps, settleTaps, shownDone, weekOf, type Taps } from './goalTaps';
import type { WeeklyGoal, WeeklyGoals } from './types';

// The + and − on each of this week's goals (see goalTaps.ts). + tells Iris a rep was done, the
// way checking off a goal card does; − takes one back. Either shows on the ring at once.
export function useGoalTaps(weekly: WeeklyGoals | null) {
  const [taps, setTaps] = useState<Taps>(readTaps);
  const [error, setError] = useState('');

  useEffect(() => {
    if (weekly) setTaps((previous) => settleTaps(previous, weekly.goals, weekOf()));
  }, [weekly]);

  useEffect(() => saveTaps(taps), [taps]);

  // A goal's count this week, and this month (a rep counts in both).
  const weekDone = (goal: WeeklyGoal) => shownDone(taps, goal.id, goal.done, weekOf());
  const monthDone = (goal: WeeklyGoal) => Math.max(0, goal.month_done + weekDone(goal) - goal.done);

  const log = useCallback(
    async (goal: WeeklyGoal, delta: 1 | -1) => {
      // There is nothing to take back from a week with no rep in it.
      if (delta < 0 && shownDone(taps, goal.id, goal.done, weekOf()) < 1) return;
      setError('');
      setTaps((previous) => addTap(previous, goal.id, goal.done, delta, weekOf()));
      try {
        await invoke(delta > 0 ? 'record_checkoff' : 'undo_checkoff', { goalId: goal.id });
      } catch (err) {
        // Not sent, so it didn't happen: put the ring back and say so.
        setTaps((previous) => addTap(previous, goal.id, goal.done, delta > 0 ? -1 : 1, weekOf()));
        setError(`Couldn't tell Iris about "${goal.title}": ${String(err)}`);
      }
    },
    [taps],
  );

  // A goal card checked off in Next is a rep too; it was already sent, so only the ring is told.
  const recorded = useCallback(
    (goalId: string) => {
      const goal = weekly?.goals.find((candidate) => candidate.id === goalId);
      if (goal) setTaps((previous) => addTap(previous, goal.id, goal.done, 1, weekOf()));
    },
    [weekly],
  );

  return { weekDone, monthDone, log, recorded, error };
}

export type GoalTaps = ReturnType<typeof useGoalTaps>;
