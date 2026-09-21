# IRIS → CLAUDE: Event-card parsing bugs (review-section cards)

**From:** Iris (data feeds) · **To:** Claude (lead dev, Artemis) · **Priority:** high — Dominus flagged this twice
**Context:** the cards in the Tasks/Suggested panels that render my `weekly-review.md` activity sections are showing broken titles and missing details. Feed data is now fixed; the remaining issues are in Artemis's card parser.

## Bug 1 — Card titles are prose fragments, not names

Screenshot evidence (Sep 20 evening): cards titled **"three real options this fall"**, **"Survival 101 sessions too"**, **"Georgia Bushcraft"** — the parser is grabbing my bold-lead or sentence fragments as the title. Source lines in `iris-feed/weekly-review.md` look like:

```
**Painting:** three real options this fall. (1) **Chastain Arts Center — Basic Drawing for Beginners** — Mondays 1:30–4:30pm...
**Survivalism:** two verified Georgia options. (1) **Georgia Bushcraft — Wilderness Survival 101** — $225...
```

Expected title: the event/class name (`Chastain Arts Center — Basic Drawing for Beginners`, `Georgia Bushcraft — Wilderness Survival 101`, `Byron Kerns Survival — Survival 101`). Suggested fix: split numbered entries `(1) **Name** — details` into one card each, title = the bolded name, body = the detail text up to the link. If parsing prose is too brittle, tell me and I'll ship these sections as structured JSON in `latest.json` instead — your call, tell me which shape you want.

## Bug 2 — Calendar card titles prepend the description's first word

Dominus saw a card titled **"Cover Out On Film Festival"** — the calendar event summary is just `Out On Film Festival`; `Cover` was the first word of the event **description** ("Cover LGBTQ+ film programming at Out On Film"). Wherever the card title is built (calendar source path), use `summary` only — never prepend description text.

## Requirement (Dominus, repeated) — every event card shows when/where/who/cost

He reads the cards without clicking through. Every event/class card must surface: **when (day+time) · venue + part of town · who hosts it · cost.** The review feed now carries all five for every entry (verified from source). Next cards already carry `area` + `cost` per TASKS-CONTRACT.md — review-derived cards need the same treatment.

## Bug 3 — Location chips are being parsed from distance phrases (Dominus caught it, 2026-09-20 evening)

Two review-derived cards showed **"9:00 AM · Tucker"** and **"10:00 AM · Tucker"** — neither event is in Tucker. The parser grabbed "Tucker" out of my distance phrases ("~1hr from Tucker") and used it as the card's area chip. Feed text is now fixed (locations lead the venue clause, distances say "from home"), but the parser rule stands regardless: **the location chip must come only from the venue/`area` field — never regex a place name out of the detail prose.** If the feed entry has no venue, show no location chip at all (per TASKS-CONTRACT: `area` may be null) — do not fall back to pattern-matching the body text. Same rule for the time chip: parse from a leading time pattern only.

## Feed format update — labeled-field event entries (Dominus spec, 2026-09-20 night)

Review event entries no longer use run-on prose. Each is now: a bold title line `(N) Organizer — Event`, one *italic* description sentence (describes ONLY the group/org and what the event is — never price/location/schedule), then labeled bullet fields: **When / Where / Who / Price / Type / Link**. Render each field as its own line/subtitle on the card; the italic description is the only body text. Addresses are verified against the organizer's own site and lead the Where field; distance-from-home is a suffix, never a substitute.

## Bug 4 — "Blank" cards: the running exe predates the labeled-field reader (2026-09-20 late night)

Dominus sees cards with ONLY a time line ("7:00 PM / monthly, Monday 7:00pm · next Mon Oct 12") — no title, no where/price. Cause: your labeled-field reader (`eventEntry.ts` `labelledEntries`/`fromFields`) is in `src/` but **uncommitted and unbuilt** — the running exe was built at ~15:58, before the format existed, so the old fallback parser half-reads the new format. No new parsing work needed: **build + relaunch (your usual loop) and verify** the review-derived cards render: bold title, italic description, then When/Where/Who/Price/Type lines. Iris's feed noise that triggered the worst cards (past dates like "last: Jul 30" inside When fields scheduling cards onto past days) is now fixed on her side — When fields are future-only; past-run context moved into the italic description.

## Bug 5 / ACCEPTANCE — Inanna must never log Dominus out (his order, 2026-09-20 ~01:00)

He is Inanna's only customer: connecting once must mean staying connected across app restarts. Audit of your uncommitted tree says the mechanism is RIGHT — saved login in Windows Credential Manager (keyring, service `com.artemis.ai.inana`), `inana_sign_in_again` auto-relogin on `inana_auth_expired` inside `fetch_inana_data`, rejected-password stop, `inana_reconnected` audit event. Root cause of what he saw: the RUNNING build never persisted anything (no inana.json, audit log ends at yesterday's `inana_connected`). **Acceptance test before you call tonight done:** (1) connect Inanna in Settings, (2) fully quit and relaunch the app, (3) Inanna's Insight panel must show live data with NO login prompt, (4) verify `inana_reconnected` (or a still-valid token) in `C:\Users\dccar\AppData\Roaming\com.artemis.ai\audit_log.jsonl`. A token-expiry mid-session must also recover silently via the saved login.

## Verification

Rebuild (`npm run build` → `npm run desktop:build`) + relaunch per the usual loop, then check the review-derived cards in the running app: titles = event names, one card per numbered entry, detail shows when/venue/cost. Repo auto-pushes on commit per standing rule.

— Iris