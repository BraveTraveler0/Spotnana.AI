# IRIS BRIEF — Harden feed parse: one null scalar kills the whole dashboard

**From:** Iris · **To:** Claude · **Priority:** HIGH · **Date:** 2026-09-23

## The problem (Dominus's framing)
"Worth a taste" (Restaurants & bars / Cooking) vanished from the Daily tab this morning. Not a feed problem — the recs were in latest.json all along. Not a stale build — the exe was current.

## Root cause (verified live over CDP)
This morning's Panel Feed run (7:30am) wrote ONE task card with `"action": null` (next-8, "Do a Chance round"). `IrisTaskCard.action` in `src-tauri/src/lib.rs` is `action: String` — no `#[serde(default)]`, no null tolerance (it was hardened 09-21 in b6afebf, but as a bare required `String`, not an `Option`). One null made `serde_json::from_str::<IrisFeedIndex>` fail on the ENTIRE index, `get_iris_feed` returned `Err("Could not parse Iris feed index: invalid type: null, expected a string at line 162 column 22")`, and the frontend's `.catch(console.error)` silently kept yesterday's feed (which predates the recs). Result: taste strip gone + ALL of today's cards/insights stale, with zero visible errors.

**I already fixed the data** (latest.json next-8 `action` → `"accept"`, `updated` bumped 11:52) — the strip is back and verified rendering. I also hardened the writer: Panel Feed job prompt now pins `action` to the literal `"accept"` and adds a pre-write validation gate; TASKS-CONTRACT.md card-shape updated to match.

## The ask (build list)
1. **Null-tolerant scalars on IrisTaskCard.** Make `action` an `Option<String>` (or `#[serde(default)]` with a null-catching deserializer like the existing `string_or_number` used for `rating`). While you're in there: any other bare `String` field on feed structs that Iris's writers may emit as null should get the same tolerance (`id`/`title` are already `#[serde(default)]`, fine to keep — `usable_cards`/`usable_recs` already drop empties).
2. **Parse-failure must not be silent.** In `get_iris_feed`, on index parse error, don't just bubble an `Err` the frontend logs to console — return the error text in a way the UI can surface (even a small banner/toast on the Daily tab: "Feed parse failed: <error> — showing stale data"), so a future feed bug is visible within one poll cycle instead of silently freezing the dashboard.
3. Rebuild + relaunch as usual; the running exe is current except for this fix.

## Guardrails (unchanged)
- Artemis READS `iris-feed/`, never writes it; contract mds are read-only for you.
- Don't touch `latest.json` — the data side is fixed and live.
- Privacy boundary as always.

## Definition of done
- `npm run build` passes.
- A feed JSON with a null in ANY scalar field parses without failing the whole index (unit test: feed with `action: null` → cards still load).
- Live check over CDP: Daily tab renders, taste strip present, no `exceptionThrown`.
- Report back in `CLAUDE-REPLY-feed-parse-hardening.md` (repo root) with what changed + test evidence.

*Iris can do small surgical edits if this sits unaddressed 3+ hours (per standing rule), but parser/struct changes are your lane — flag if you'd rather shape it differently.*