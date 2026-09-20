# ARTEMIS HANDOFF — Context Bundle from Iris (Hermes)

> Written by Iris (the user's Hermes Agent instance) 2026-09-19, at the user's request: "connect with Artemis and give her all of this information." Artemis should ingest this file to share context with Hermes. A machine-readable summary is at the bottom.

## 0. PRIVACY BOUNDARY (hard rule, added 2026-09-19)

**Anything the user types into Artemis in privacy mode NEVER leaves the user's machine.** Iris must never receive, request, export, or repeat privacy-mode content — not in handoffs, cron jobs, reports, or chat. Artemis and Hermes are *sibling local agents*: Iris's role is **helping with the dashboard and planning features** (goals, schedules, events, training arcs, book pipeline) — not mirroring the user's private conversations. When in doubt, Artemis keeps it, Iris doesn't ask.

## 1. Who the user is (dccar)

- UX designer (job + passion); loves beauty/art — classical & neoclassical first (da Vinci, Jacques-Louis David, Caravaggio, Michelangelo, Bouguereau); film: Kubrick, Cuarón, Nolan, Tarantino, Fincher, Kurosawa, Katsuhiro Otomo; loves cinematography; "beautiful forms with layers of meaning."
- Writer: aspiring author (active book project — needs stronger hooks). Favorite writers: Baldwin (aspirational), Camus, Hemingway, Bukowski, Du Bois, Fry; craft bibles: Storyworthy (Matthew Dicks), Elements of Eloquence (Forsyth), McKee's Story/Dialogue, Stein on Writing, Thank You for Arguing (Heinrichs).
- MMA practitioner (~1 lesson/week, southpaw striking — boxing/Muay Thai/JKD interception). Heat gate: no outdoor workouts ≥90°F, high 80s already too hot.
- Currently in **Tucker, GA** (Sep 2026); Decatur is close; Atlanta trips are all-day affairs (~$40 Uber / 30 min by bike, avoids highway). Long-term plans in `Goals.md` include extended stays: Brazil, Colombia, Thailand, Japan, and more (2026–2035).
- Calls Hermes **"Iris."**

## 2. Standing etiquette rules (hard)

- **NEVER delete anything** in `C:\Users\dccar\OneDrive\Desktop\Projects` or the Obsidian vault without asking first.
- Obsidian vault (`C:\Users\dccar\OneDrive\Documents\Ma'at`): may ADD freely (new notes / clearly-marked appended sections); ASK before altering/deleting.
- Never fabricate: quotes (always author/work/context or marked paraphrase), tool results, resume credentials.
- Carolina persona: email drafts are deliverables to the user, never auto-sent; never fabricate experience.

## 3. Knowledge base (local, no cloud — the privacy-first pattern Artemis should copy)

- SQLite FTS5 index: `C:\Users\dccar\HermesKB\library.db` (442MB), queried via `C:\Users\dccar\HermesKB\venv\Scripts\python.exe C:\Users\dccar\HermesKB\kb_search.py`:
  - `search "<q>" [--corpus books|notes] [--folder X]` — books (571 docs incl. 22 persuasion-craft PDFs) + Obsidian notes (7,076)
  - `note "<name>"` — full vault note; `get <doc_id> <page>` / `pages <id> <from> <to>` — book pages verbatim; `code "<q>" [--proj P]` — 3,275 source files across the Projects repos
- Builders (incremental): `build_index.py` (books), `build_notes.py` (vault), `build_code.py` (projects).
- Venv: `C:\Users\dccar\HermesKB\venv` (pymupdf, ddgs). All local — no cloud RAG, no external embedding calls.

## 4. Personas (7) — full specs in `C:\Users\dccar\AppData\Local\hermes\skills\`

Zera (comparative philosophy) · Storytelling Mastermind (story/comedy/persuasion/performance) · Carolina (career/people/emails; human-feeling bot pattern) · Zora (design/branding/UX) · Plato (deep fiction: myth+philosophy+politics) · Mal (southpaw MMA coach; knowledge docs = KB doc 7626/7627) · Nefrititi (dual-mode prose editor/story architect).

## 5. Schedules & services

- Morning Brief: daily 9:30am (weather + heat gate + calendar + daily focus). Weekly Review: Sundays 11am. **Gateway not yet started** (`hermes gateway start`) — jobs saved but dormant.
- Google OAuth paired (Gmail/Calendar/Drive/Sheets/Docs/Contacts; token at `%LOCALAPPDATA%\hermes\google_token.json`). User wakes ~9am weekdays, 11am weekends.
- Web search: Firecrawl broken (403) — use ddgs (`ddgs` package in HermesKB venv) + wttr.in for weather.

## 6. Local-events mission (Tucker/Decatur/Atlanta) — DISTANCE-AWARE

The user's base is **Tucker, GA (~33.8546, -84.2218)**. **Travel: the user rides an E-BIKE (~35 mph capable, avoids highways)** — real measured bike time Tucker→Midtown ≈ 21.8 km / ~23 min (OSRM cycling), so Decatur AND Midtown are both easy spontaneous trips; Uber ~$40 is the fallback. Distance bands for recommendations: **<25 min bike = easy trip · 25–40 min = normal trip · 40+ min or rain = plan ahead / indoor alternative**.

## 6.5 The Iris Feed (Iris → Artemis output channel)

`Projects\Artemis\iris-feed\` is the **official integration point**: Iris writes its outputs there as plain markdown + a `latest.json` index; Artemis watches the folder and renders them (pretty UI = Artemis; brain = Iris). Contract documented in `iris-feed\README.md`: stable heading names for parsing (## Philosophical Spark, ## Weather, ## Calendar, ## App Health, ## Inanna, ## Today's Suggestion), files `YYYY-MM-DD-brief.md`, `YYYY-MM-DD-events.md`, `weekly-review.md`, `philosophical-spark.md`. The "One Suggestion" is a yes/no interactive card; answers flow through the user (or `call_hermes_agent`) — Artemis renders, Iris acts. **Claude: build the watcher/reader; never delete files here (Iris rotates them).**

Weekly scan for events matching the Goals.md threads: **martial arts** (boxing, Muay Thai, BJJ, Judo, Capoeira, HEMA/fencing, TKD), **writing/storytelling** (Moth StorySLAMs, open mics, workshops), **painting/art classes**, **survivalism** (foraging, bushcraft, hunter-ed, first aid), **adult social / meeting women late 20s** (speed dating 25–39, Timeleft, singles mixers, hobby classes). Hermes runs a weekly scout job (Mondays 10am); Artemis should mirror these interests for her own recommendations.

**Confirmed nearby (2026-09):** The Moth StorySLAM Atlanta — Mon Sep 28, 7:30pm, Vinyl @ Center Stage (10.5 mi, THE priority event; user explicitly wants to do a Moth) · Eddie's Attic songwriters open mic, Decatur (7.0 mi, Mondays) · Capoeira Maculelê, downtown Decatur (bikeable) · Unit 2 Fitness BJJ/Muay Thai, Decatur · Atlanta Historical Fencing Academy (HEMA) · Painting with a Twist Edgewood (9.8 mi) + figure-drawing courses (Basic Tue 6–9pm $240/8wk) · X3 Sports free Muay Thai trial (10.2 mi) · SpeedAtlanta 25–39 @ Establishment Bar Midtown (10.3 mi) · Timeleft Atlanta weekly dinners · user's WFA course Sep 19–21 Atlanta (confirm venue).

## 7. Machine-readable summary

```json
{
  "privacy_mode": "content typed in Artemis privacy mode NEVER leaves the machine; Iris never receives/exports it; Iris's role = dashboard + planning help only",
  "user": {"nickname_for_hermes": "Iris", "location": "Tucker, GA", "job": "UX designer", "base_coords": [33.8546, -84.2218],
           "interests": ["martial arts","writing/storytelling","painting","survivalism","philosophy","history","law","politics","art/film"],
           "mma": {"per_week": 1, "heat_limit_f": 88},
           "book_project": "active, needs stronger hooks"},
  "etiquette": {"delete_without_asking": false, "vault_add_freely": true, "fabricate_anything": false},
  "paths": {"vault": "C:\\Users\\dccar\\OneDrive\\Documents\\Ma'at",
            "projects": "C:\\Users\\dccar\\OneDrive\\Desktop\\Projects",
            "goals_doc": "C:\\Users\\dccar\\OneDrive\\Documents\\Ma'at\\I. Sketchbook\\Goals.md",
            "kb_db": "C:\\Users\\dccar\\HermesKB\\library.db",
            "kb_cli": "C:\\Users\\dccar\\HermesKB\\venv\\Scripts\\python.exe C:\\Users\\dccar\\HermesKB\\kb_search.py",
            "skills_dir": "C:\\Users\\dccar\\AppData\\Local\\hermes\\skills"},
  "corpora": {"books": 571, "vault_notes": 7076, "code_files": 3275},
  "personas": ["zera-philosopher","storytelling-mastermind","carolina-career-coach","zora-creative-director","plato-fiction-writer","mal-mma-coach","nefrititi-scribe"],
  "schedules": {"morning_brief": "daily 9:30am", "weekly_review": "sunday 11am", "local_events_scout": "monday 10am"},
  "google": {"paired": true, "token": "%LOCALAPPDATA%\\hermes\\google_token.json"},
  "event_interests": {"cities": ["Tucker GA","Decatur GA","Atlanta GA"], "categories": ["martial arts","storytelling/Moth","painting classes","survivalism/foraging/hunter-ed","speed dating / Timeleft / singles mixers 25-39"]}
}
```