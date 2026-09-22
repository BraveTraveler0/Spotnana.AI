# IRIS-BRIEF-points-ui.md

**From:** Iris · **To:** Claude · **Priority:** Medium (not blocking — data side already live)
**Date:** 2026-09-21

## What Dominus ordered (his framing)

"Writing or editing my writing daily is worth more points than the other activities because it's training. Let's do at least 4 a week and they're all worth 3 points instead of 1. Working out is now worth 2 instead of 1 as well."

So: a points economy on top of the existing check-off ring. Writing is the priority track — 4x/week floor, 3 pts per session (drafting OR editing both count). Workouts are 2 pts (weights and MMA each). Everything else stays 1 pt.

## What I already changed (data side — done, live)

- `HermesKB\daily-defaults.json`: new `weekly_minimums` entry `writing` (target 4, category writing); new `points` block (values table: writing 3, weights 2, mma-session 2, others 1; default 1; ledger path); workout_note updated; `weekly_minimums` id list in prompts updated.
- `HermesKB\weekly-goals.json`: `goals[]` gained a `writing` goal (id `writing`, target 4, category writing); `minimums` object gained the `writing` key (join key for check-offs — mirrors daily-defaults). Week 2026-09-21, counters at 0.
- `HermesKB\points-ledger.jsonl`: NEW, append-only. One line per point award: `{"date": "<ISO date>", "id": "<minimum/goal id>", "type": "minimum|goal", "points": <int>, "sent_at": "<ISO now>"}`. Written by Iris's jobs when consuming check-offs. NEVER written by Artemis.
- Cron prompts updated (Panel Feed f5a13c4efd58, Weekly Goals Night d8ae81953316, Morning Brief 112bdaefd8a2): writing minimum in the evergreen lists + ledger-write instruction on every check-off consumption.
- `iris-feed\TASKS-CONTRACT.md`: TaskCard gained `points` (int or null); new "Weekly points" section documenting the ledger + weekly-total math (sum of ledger points where date is in the current ISO week, Mon-start).

## Build list (UI, your lane)

1. **Point badge on cards** — when `card.points` is set (goal/routine cards), render a small badge: `+3`, `+2`, `+1`. Keep it subtle; it sits alongside the meta line (`AREA · COST · CATEGORY`), does not replace it.
2. **Weekly points total** — read `HermesKB\points-ledger.jsonl` (read-only), sum points for the current ISO week (Monday-start). Show it wherever the weekly ring/donut lives — a line like "27 pts this week" is enough; no fake chart styling, honest number only.
3. **Writing emphasis (optional but wanted)** — writing cards (goal_id `writing`, category `writing`) are the priority track; if it's cheap to give the badge a highlight tint (the accent var), do it. Do not redesign the card.
4. **Contract** — `points` field and ledger semantics are in `iris-feed\TASKS-CONTRACT.md` (TaskCard shape + "Weekly points" section). Follow it.

## Guardrails (unchanged)

- Artemis READS `iris-feed\` and `HermesKB\*.json/jsonl`; it NEVER writes them. Check-offs still go through `checkoffs.jsonl` (Iris consumes → appends completion AND ledger line).
- `points-ledger.jsonl` is append-only; Artemis never rewrites or trims it.
- Privacy boundary per §0 of CLAUDE_BRIEF.md.

## Definition of done

- `npm run build` passes.
- Live render check per the usual CDP loop (relaunch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, root innerHTML > 0, zero `exceptionThrown`): cards with `points` show the badge; weekly total renders a real number (seed a fake ledger line ONLY for the render check, then delete it — the ledger must ship empty).
- Report back in `iris-feed\CLAUDE-REPLY-points-ui.md`: what changed, files touched, build output tail, render-check evidence.

— Iris