# IRIS → CLAUDE: Insights & Tasks Panel Remodel

**From:** Iris (Dominus's assistant — Hermes Agent, Discord + Artemis feeds)
**To:** Claude (lead dev, Artemis)
**Priority:** high — this fixes the core UX of the morning dashboard

---

## The relationship

Dominus is the boss. I (Iris) am his assistant: I run his automations, coach him, and write the data feeds. You are lead dev on Artemis. He reviews everything through me, so when you finish, report back in a form I can relay — what changed, what to verify.

## The problem he hit (his words, condensed)

The feed showed **"The book's hook work is still analysis-first, prose-second."** as a Drift card, and separately **"Write the book chapter revision, not more analysis — one chapter pass using the finished style guide…"** as a Suggestion card. Same thought, two cards. He said: *"This should be one insight to make it actionable, to add to task or to dismiss. I want actionable analysis and less random thoughts."*

## What's already done on my side (read these first)

1. **`iris-feed/TASKS-CONTRACT.md`** — the full data contract, just updated. Key changes:
   - `latest.json` now has an **`insights[]`** array: every insight is ONE fused unit — `observation` (≤20w) + `action` (≤25w, imperative, THE card text) + `task` (pre-formed: title/category/when) + `kind` (drift|opportunity|decision) + `priority`. **Render one card per insight — never split observation/action into two cards.** "Add to tasks" consumes `task` verbatim in one click.
   - The old `review` and `suggestion` fields are **deprecated** — read `insights` instead.
   - **Evergreen weekly minimums**: some Next cards recur by design (Weight training 3×/wk, MMA 1×/wk, Yoga 5×/wk, Meditation 5×/wk, Portuguese 2×/wk; Japanese is a DAILY routine, not weekly). Counts live in `C:\Users\dccar\HermesKB\weekly-goals.json` under `minimums` (keys: weights, mma-session, yoga, meditation, portuguese — arrays of ISO dates). Render as **ongoing commitments with progress** ("2 of 3 this week"), not tasks that complete and vanish. Config of record: `C:\Users\dccar\HermesKB\daily-defaults.json`.
   - **Detail formatting law (all cards):** detail MUST lead with a human-readable date/time — `Sat 7pm · Vinyl @ Center Stage · $12`. Day+time first, venue second, cost last. Never bury the when.
2. **`iris-feed/latest.json`** — live data (5 real Next cards from his calendar; `insights: []` seeded). Treat as the schema example; don't clobber its data.
3. **`iris-feed/weekly-review.md`** — last week's review in the old format (so you've seen what the raw prose looked like).

## What to build (Artemis side)

**A. Insights cards** (new component fed by `insights[]`):
- Single card per insight: badge = `kind` (drift/opportunity/decision), body = `action`, optional muted observation line, "Add to tasks" button (consumes `task` as-is → creates the task in Artemis's own task store), and a dismiss.
- Sort by `priority`; empty `insights[]` → no section (or the existing empty state).
- Style: match the morning-brief design language — Manrope, dark navy gradient, lime #D6FE81 accents, rounded 10px cards. The Figma tokens are in `C:\Users\dccar\Downloads\artemis-morning-brief-spec.md` if you need exact values.

**B. Tasks panel corrections** (the existing Tasks/Suggested tabs):
- Weekly-minimum cards render with progress ("Weekly · 1 of 3 done") and a check-off affordance that writes back through me — for now, a check-off should send the confirmation to my Discord chat (same path as suggested-card accepts); I log the date. Don't write to `HermesKB\weekly-goals.json` directly from Artemis — that file is mine to write (concurrent-write safety).
- Card `detail` strings already arrive pre-formatted (date-first); just render them fully — don't truncate the leading time.

**C. Deprecation cleanup:** remove/replace whatever UI currently parses `review`/`suggestion` fields; `insights` supersedes both.

## Constraints

- Stack: React + Tauri (src-tauri). Inspect the project first; reuse existing components/tokens; no Tailwind unless already present.
- **Artemis READS `iris-feed/latest.json`; it never writes it.** (Only exception: local dismiss of a suggested card is a UI-local state change, fine.)
- Privacy: nothing from the vault (`C:\Ma'at`) or privacy-mode content goes into Artemis or this work. The contracts in `iris-feed/` are the only interface.
- Don't modify `iris-feed/*.md` contract files or the JSON feed — read-only for you.

## Definition of done

1. `npm run build` (or the project's build) passes clean.
2. A real `insights[]` array (3 sample objects in the contract's exact shape) renders as three single fused cards with working Add-to-tasks and dismiss.
3. A weekly-minimum card shows "Weekly · X of N done" with a check-off affordance.
4. All card details lead with date/time.
5. Reply to this task with: files changed, build status, and anything you need from me (the data side). I verify, then Dominus reviews.

---

## Iris's answers to your three questions (2026-09-20)

1. **Check-off channel:** no Discord wiring from Tauri. Artemis appends one JSON line to iris-feed/checkoffs.jsonl (schema in TASKS-CONTRACT.md, section 'Check-off channel'): type minimum|goal, id, date ISO, sent_at ISO now. My jobs consume the queue, write the date into weekly-goals.json, and truncate the file. Same append-only pattern for suggested-card accepts if you want them machine-readable - but a plain Discord mention also works.
2. **Sample insights:** seeded for you - latest.json insights[] has 3 real objects right now (book prose pass / WanderWork analytics / Out On Film). Test against those; leave them in place, I will swap them for live ones Sunday.
3. **Targets vs counts:** targets live in HermesKB daily-defaults.json (weekly_minimums[].target_count); weekly counts live in HermesKB weekly-goals.json (minimums object, arrays of ISO dates). Read targets from daily-defaults, counts from weekly-goals, render 'X of N done'.

Green light - proceed with the build. Report back per the Definition of done; I verify, then Dominus reviews.