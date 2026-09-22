# IRIS → CLAUDE: Taste shelf moved to middle column + images +/× (2026-09-21 19:10, done by Iris per Dominus's direct order)

**UPDATE 19:55 — Dominus's second round (all done, in the same build):** taste section moved to the BOTTOM of the middle column (under Insights); split into two shelves — "Restaurants & bars" vs "Cooking" (split on `kind === 'recipe'`); agenda list (`.dd-task-list`) height-capped at 560px, scrolls in place; + saves the task with NO date so it lands under **Anytime** in the Next agenda (verified live: added task appeared under the Anytime day header). TasteStrip.tsx was rewritten around a `RecShelf` subcomponent — check it before editing.

**Priority: HIGH — already built and committed-to-tree by Iris. Fold into your current build; do not redo.**

## What Dominus asked for (his words)
"i should be able to add these to my calendar with the same + or x system if needed. they also need images" + "Just move it to the middle, it looks silly on the side. And add a recipe so I know what it'll look like."

## What Iris changed (4 files, all verified)
1. **`src/app/components/daily/TasteStrip.tsx`** — rewritten: now rendered in `DailyDashboard.tsx` middle column (between spark and Top Story, own `<Reveal delay={0.16}>`), not inside TasksPanel's Suggested tab. Cards carry `<img class="dd-taste-pic">` (96px cover, error → falls back to plain card, no broken box). + = saves a task via `addTask` (recipes get `Cook <name>` label, note = the hook, `source: 'Worth a taste'`, area kept); × = dismissed for good. Both remembered in localStorage keys `artemis.daily.tasteDismissed` / `artemis.daily.tasteAdded` (30-day retention, same pattern as your handledCards). TasksPanel no longer takes `recs`/`onAddRec` — don't re-add them there.
2. **`src/app/components/daily/types.ts`** — `TasteRec.image: string | null`.
3. **`src-tauri/src/lib.rs`** — `TasteRec` struct + `image: Option<String>` (`#[serde(default)]`). This was required: serde silently drops unknown JSON fields, so the frontend type alone did nothing. `cargo check` passes.
4. **`daily.css`** — `.dd-taste*` restyled as a middle-column section: serif title (matches dd-section-title), 190px cards, corner + button (same look as `.dd-suggest-add`) and × under it, `.dd-taste-added` = "On your list" state.

## Feed side (my lane, already live in latest.json)
- All 3 existing recs have verified photos now (VinoTeca interior from their Squarespace CDN, Hal's lobster mac from their Wix CDN, City Winery — **their og:image is a text wordmark, I used it anyway for now; if you have 5 min, swap in a real venue photo**).
- Seeded `rec-chicken-tinga` (Serious Eats one-pot chicken tinga, Wikimedia Commons photo) so Dominus sees the recipe-card shape.
- Fixed Hal's dead link (halsthesteakhouse.com → www.hals.net).
- `TASKS-CONTRACT.md` "recs" section documents the `image` field + photo-not-logo rule. Future scout/Panel Feed runs should populate it.

## Verification done
`npm run build` passes (vite, 16.5s); `cargo check` passes; Tauri release build running. Feed images fetched and eyeballed via vision (logo check). Acceptance for your build: Daily tab → middle column shows "Worth a taste" under the spark with 4 pictured cards; + on a card puts it on Next with a lime "On your list" mark; × makes the card vanish and stay gone after restart; Suggested tab no longer shows the strip.

## Calendar note (Dominus's "add to my calendar")
The + currently adds to the Artemis task list (Next), same as the suggested-card + — that's the system he pointed at. If he wants these pushing to Google Calendar too, that's a Rust-side `accept_iris_task`-style command — your call where it lands; feed data already carries `area`/`link`.