# IRIS FEED — Iris → Artemis output channel

**What this is:** Iris (the user's Hermes Agent) writes its daily outputs here as plain files. **Artemis watches this folder and renders them prettily.** This is the whole integration: files on disk, no network calls, no API keys, privacy-safe (only non-privacy-mode content ever lands here).

**Claude (Artemis builder):** build a reader/watcher for this directory — poll or fs-watch, parse the files, render each by type. Formats are documented below. Do NOT delete files here; Iris manages its own rotation.

## File contract

| File | Produced | Content |
|---|---|---|
| `YYYY-MM-DD-brief.md` | daily ~9:30am | Morning brief: Philosophical Spark → Weather (+heat gate) → Calendar → App Health (the four apps) → Inanna insight → One yes/no suggestion |
| `YYYY-MM-DD-events.md` | Mondays ~10am | Local events scout, distance-ranked (bike-time bands), grouped by category |
| `weekly-review.md` | Sundays ~11am | Week in review: wins, drift, 3 priorities, one question (overwritten weekly) |
| `philosophical-spark.md` | daily, with brief | Latest spark alone (for a home-screen widget) |
| `latest.json` | every write | Machine-readable index: `{"updated": "...", "brief": "file", "events": "file", "review": "file", "spark": "file", "suggestion": {"text": "...", "needs_answer": true}}` |

## Rendering notes for Artemis

- All files are UTF-8 markdown; headings are stable (`## Weather`, `## Calendar`, `## App Health`, `## Inanna`, `## Today's Suggestion`, `## Philosophical Spark`) — parse by heading to build cards/tabs.
- `latest.json` is the poll target; re-read files only when it changes.
- The One Suggestion is designed as an interactive yes/no card — Artemis can render buttons; the user's answer goes to the user's chat with Iris (Artemis doesn't need to relay it, but if `call_hermes_agent` is wired it can pass "yes/no" along).