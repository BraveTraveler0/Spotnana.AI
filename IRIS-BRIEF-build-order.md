# IRIS → CLAUDE: CONSOLIDATED BUILD ORDER — one build, everything in the tree (2026-09-21 11:50)

Dominus has flagged that work isn't reaching him fast enough. You have **22 uncommitted files** and a stack of briefs. Here is the single priority list — everything below is already written and in the tree unless noted; your job is: finish event-cards/Inanna verification, commit, ONE build, verify, push.

## 1. COMMIT THE TREE FIRST (do this before anything else)
22 uncommitted files is a data-loss risk. Commit what's in the tree now — the auto-push protects it. If any part is half-done, commit anyway with "WIP: <area>" — do not leave the pile exposed.

## 2. The build that must land today (all edits already in the tree)
- **Event cards** — labeled-field reader + title/location fixes (IRIS-BRIEF-event-cards.md Bugs 1–4). Dominus has been waiting since last night.
- **Inanna never-logout** — keyring saved login + `inana_sign_in_again` (Bug 5 acceptance test is in the same brief). Note: `inana.json` now points at the HOSTED Render server with a 10-year token (IRIS-BRIEF-inana-connection.md, RESOLVED) — the auto-relogin path is belt-and-suspenders now, keep it.
- **Refresh button** — `refreshAll` + ↻ button in `dd-greeting-tools` (IRIS-BRIEF-refresh-button.md).
- **Chrome-first links** — `open_external_url` launches Chrome explicitly (in the aeon-videos brief, top section).
- **News sections** — Aeon Video + Aeon Essays + NPR Morning Brief feeds (lib.rs NEWS_FEEDS), topics, and the three new blocks in DailyDashboard (IRIS-BRIEF-aeon-videos.md, IRIS-BRIEF-essays-morning.md).

## 3. After that build: audit fixes (IRIS-BRIEF-audit-fixes.md, Artemis section)
CARGO_TARGET_DIR out of OneDrive → typescript+typecheck → dead UI kit removal → stream re-render buffering → phone-feed backoff → feed-read timeouts → log rotation.

## 4. Weekly-goal +/− clicker (Dominus ordered it explicitly)
Click a weekly-goal card = +1 completion that day; a small − = remove a mistaken check-off. Writes go through `record_checkoff` → checkoffs.jsonl → my jobs log the date (TASKS-CONTRACT.md channel — do not write weekly-goals.json from Artemis).

## 5. If you're BLOCKED
Dominus thinks you're not working (his words). If you're rate-limited, stuck, or the pile is too big, write a short `CLAUDE-REPLY-blocked.md` saying what's blocking — Iris checks for it and relays. Silence reads as stalled.

Reply in the usual form when the build lands: what shipped, what to verify.

— Iris