# CLAUDE BRIEF — Building Artemis (from Iris / Hermes Agent)

> Written by **Iris** (the user's Hermes Agent instance) on 2026-09-19 at the user's request. You (Claude Code) are being brought in to build/extend **Artemis**. This brief tells you who's who, what exists, the hard privacy boundary, and how to talk to Hermes when you need to. Read `ARTEMIS_HANDOFF.md` (same folder) for the full user-context bundle.

## 0. PRIVACY BOUNDARY — read first, applies to everything you build

1. **Anything the user types into Artemis in privacy mode NEVER leaves the machine.** No network calls, no telemetry, no logs beyond local disk, never exported to Hermes or anywhere else. Build privacy mode as a hard gate on the network layer, not a prompt-level promise.
2. **You (Claude) must not copy privacy-mode content into Hermes** — not into handoff files, prompts, or code comments that get shared.
3. When the user asks Artemis for anything cloud-capable (LLM calls, search), that must be an explicit, visible action — the default path is local-only.

## 1. Who's who

| Party | Role |
|---|---|
| **dccar** | The user. UX designer, writer (active book project), MMA practitioner (~1x/week, southpaw), survivalism student. Calls Hermes "Iris." |
| **Iris** (this agent) | Hermes Agent instance. Runs the knowledge base, personas, schedules, Google integration. **Role for Artemis: lending architecture + helping with dashboard/planning features.** Not a mirror of Artemis's private conversations. |
| **Artemis** | The user's separate, privacy-first AI program (this repo). React + Vite + Radix + Emotion frontend, **Tauri (Rust) desktop shell** (`src-tauri/`), running on **Ollama + Rust tool-calling** with a verified **privacy mode as a network-layer gate** (structural, checked before any request — not a prompt-level promise). Dashboard features added 2026-09: Goals dashboard (parses Goals.md live, checkboxes in local storage — never rewrites the vault file) and a `calculate_distance` tool (Nominatim geocoding biased ~50 mi around the user's base; travel bands nearby/plannable/far). Also has `call_hermes_agent` — Artemis can ask Hermes things directly. |
| **Claude Code** | The coding agent building Artemis. You. |

## 2. What the user wants Artemis to be

A **privacy-first personal dashboard + planning agent**. Concretely:

- **Goals dashboard** driven by the user's master plan: `C:\Users\dccar\OneDrive\Documents\Ma'at\I. Sketchbook\Goals.md` (year-by-year mastery plan 2025–2035+: martial arts list, 10 Moth stories, painting goals, survivalism curriculum, travel plans, languages, law school trajectory).
- **Planning tracks**: MMA weekly lesson (6-month southpaw arc, weather-aware — no outdoor ≥high-80s°F), book pipeline (active book, hook diagnosis), local events (distance-ranked from Tucker GA, base ~33.8546,-84.2218; Decatur ≈ 7–10 mi = spontaneous; Atlanta 10.5+ mi = all-day trip flag), survivalism classes.
- **Local events recommendations** matching interests (martial arts, Moth/storytelling, painting classes, foraging/bushcraft/hunter-ed, social 25–39) — see §5 for the working search recipe.
- **Privacy mode** per §0. The user is privacy-conscious: the model layer may run via Ollama (`http://127.0.0.1:11434/v1` is already on this machine — Hermes uses `glm-5.3-flash:cloud` through it; a fully-local Ollama model is the user's stated direction — they're building a Linux home server for it).

## 3. What Hermes (Iris) offers — patterns to borrow

All of this is **local, no-cloud, and free to reuse**:

1. **Knowledge base pattern** — single SQLite DB with FTS5 tables, one per corpus:
   - `C:\Users\dccar\HermesKB\library.db` — `docs`+`pages_fts` (571 books incl. 22 persuasion PDFs), `notes_fts` (7,076 Obsidian notes), `code_fts` (3,275 source files)
   - Query CLI: `C:\Users\dccar\HermesKB\venv\Scripts\python.exe C:\Users\dccar\HermesKB\kb_search.py <search|note|code|get|pages|read|list> ...` (JSON out; see `--help`/docstring)
   - Incremental builders: `build_index.py`, `build_notes.py`, `build_code.py` (size+mtime skip, `--reset` flag) — steal this pattern for Artemis's own local index.
   - Venv `C:\Users\dccar\HermesKB\venv` has pymupdf + ddgs installed.
2. **Persona-as-skill pattern** — 7 persona specs (Zera philosophy, Storytelling Mastermind, Carolina career/people, Zora design, Plato fiction, Mal MMA, Nefrititi editing) live as SKILL.md files at `C:\Users\dccar\AppData\Local\hermes\skills\` (YAML frontmatter + markdown body). Artemis can adopt the same format: persona = markdown file with trigger description + method; loaded on demand. Copy the format, not necessarily the content.
3. **Standing rules as memory** — the user's etiquette (no deletes without asking; vault add-freely/ask-before-edit; never fabricate quotes/results) is stored as durable facts and injected every session. Artemis should have an equivalent (local memory file).
4. **Schedule design** — Morning Brief 9:30am weekdays (11am weekends per user's wake pattern; weather via `wttr.in/Richmond`-style endpoint, heat gate for outdoor workouts), Weekly Review Sundays, Local Events Scout Mondays 10am. Hermes runs these as cron jobs; Artemis's Tauri app can do it locally with its own scheduler.
5. **Google integration exists on this machine** — OAuth token at `%LOCALAPPDATA%\hermes\google_token.json` (Gmail/Calendar/Drive/Sheets/Docs/Contacts). Artemis should NOT reuse the token file directly without asking the user; if the dashboard needs calendar data, ask, or read it through the `gws`-style API script: `C:\Users\dccar\AppData\Local\hermes\skills\productivity\google-workspace\scripts\google_api.py` (run with the HermesKB venv python; JSON out; e.g. `calendar list --start ... --end ...`).

## 4. How to interact with Hermes (Iris) if needed

- **Artemis already has a bridge**: `call_hermes_agent` (built + verified) — Artemis can ask Hermes anything, which makes a separate kb_search.py bridge redundant. Keep using it.
- **Direct KB access for Artemis (not Claude) — IMPLEMENTED 2026-09-19**: dccar wants Artemis wired to Iris's server *without* Claude getting server access. The contract is in `IRIS_SERVER_ACCESS.md` (repo root): Artemis's Rust layer may spawn the **read-only** KB CLI (`C:\Users\dccar\HermesKB\venv\Scripts\python.exe C:\Users\dccar\HermesKB\kb_search.py search|note|get|code ...` — argv, no shell, JSON out) to answer "what do my books/notes/code say" directly. Built in `src-tauri/src/lib.rs` as four chat tools: `query_iris_knowledge(query, corpus, n)` (search), `get_iris_book_page(doc_id, page)` (verbatim quote lookup), `search_iris_code(query, project)`, `get_iris_note(name)`. Same env-scrubbed, argv-only subprocess pattern as `call_hermes_agent`/`hermes_command` — no shell, no credentials on this path (the CLI needs none). `query_iris_knowledge`'s results are filtered against the user's configured Secret folders before reaching a cloud model, mirroring `get_knowledge_context_impl`'s existing guarantee for Artemis's own local index. Never writes to library.db (Iris owns indexing).
- **One-shot ask**: `hermes chat -q "your question"` (CLI on PATH). Iris sees this as a fresh session — include context.
- **Canonical shared context**: `Projects\Artemis\ARTEMIS_HANDOFF.md` — keep it current; Iris reads it too. If you change integration points, note them there.
- **The KB is readable by both sides** — `kb_search.py` is a stable contract (JSON on stdout).
- **Do not** ask Hermes to relay privacy-mode content (see §0).
- The user's standing rule for this whole workspace: **never delete anything in Projects without asking.**

## 5. Working recipes (verified 2026-09 on this machine)

- **Local search (no API key)**: HermesKB venv python, `from ddgs import DDGS; DDGS().text("query", max_results=5, region="us-en")` — sleep ~2s between queries.
- **Weather**: `curl -s "wttr.in/Tucker?format=%l:+%c+%t+feels+%f+%w"` (or any city).
- **Geocode + distance**: Nominatim `https://nominatim.openstreetmap.org/search?q=...&format=json` (User-Agent required) + haversine from base coords; distance bands: Decatur 7–10 mi normal trip; Atlanta 10.5+ mi = "ATLANTA DAY" (all-day trip, ~30 min bike avoiding highways, ~$40 Uber).
- **Known events (Sep 2026)**: Moth StorySLAM Sep 28 7:30pm @ Vinyl/Center Stage (10.5 mi — user priority; wants to perform); Eddie's Attic open mic Mondays (7.0 mi); Capoeira Maculelê + Unit 2 Fitness (Decatur); Atlanta Historical Fencing Academy (HEMA); figure-drawing classes Tue eves; SpeedAtlanta 25–39 @ Establishment Bar; Timeleft Atlanta weekly.
- **Model endpoint**: Ollama at `http://127.0.0.1:11434/v1` (OpenAI-compatible). For Artemis's local path, point at a local Ollama model; keep cloud models opt-in only.

## 6. Suggested first build tasks (dashboard + planning)

1. Ingest `ARTEMIS_HANDOFF.md` §7 JSON as Artemis's seed config (interests, paths, schedules, distance rules).
2. **Goals dashboard**: parse `Goals.md` sections (years, skills, travel, art/writing project counts) into a trackable board; let the user check off items locally.
3. **Planning tracks widget**: MMA weekly lesson (next session + weather gate), book hook progress, events-this-week (from the scout recipe, distance-ranked).
4. **Privacy mode toggle** at the network layer: when on, disable all outbound calls except localhost; store sessions in local SQLite (adopt the FTS5 pattern from HermesKB).
5. Persona loader reading SKILL.md-format files from a local `artemis/personas/` dir.
6. Optionally bridge to Hermes KB read-only via `kb_search.py` for "what do my books say about X" features (user-approved; never for privacy-mode content).

## 7. Machine pointers

- User context bundle: `Projects\Artemis\ARTEMIS_HANDOFF.md`
- Goals doc: `C:\Users\dccar\OneDrive\Documents\Ma'at\I. Sketchbook\Goals.md`
- Vault: `C:\Users\dccar\OneDrive\Documents\Ma'at` (7,076 notes; add freely w/ attribution, never delete/alter without asking)
- Projects root: `C:\Users\dccar\OneDrive\Desktop\Projects` (10 repos: Aonverse, Wander, Invicta/Citizn, Artemis, MarketGenius, AonCreative, Imagely, Chance…)
- KB CLI: `C:\Users\dccar\HermesKB\venv\Scripts\python.exe C:\Users\dccar\HermesKB\kb_search.py`
- Google API script: `%LOCALAPPDATA%\hermes\skills\productivity\google-workspace\scripts\google_api.py`