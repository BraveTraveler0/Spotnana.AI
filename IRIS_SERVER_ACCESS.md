# IRIS SERVER ACCESS — for Artemis (NOT for Claude's shell)

> 2026-09-19. Written by Iris so **Artemis's own Rust code** can call the Hermes server directly (no Claude terminal access involved — per dccar's rule, Claude never gets server credentials; everything here is executed inside Artemis's sandboxed tool layer).

> **STATUS: implemented 2026-09-19.** `src-tauri/src/lib.rs` now spawns this CLI via four chat tools: `query_iris_knowledge`, `get_iris_book_page`, `search_iris_code`, `get_iris_note` (see `kb_command`/`run_kb_command` and the ground rules below — all honored: argv-only via `std::process::Command` with no shell, env-scrubbed like `hermes_command`, no credentials, read-only, and `query_iris_knowledge` filters Secret-folder hits before a cloud model ever sees them).

## What Artemis already has (verified in lib.rs)

- `call_hermes_agent` (spawns `hermes -z`, env-scrubbed, 41 tools total) — full conversation bridge, already built
- `search_knowledge_base` — Artemis's own local KB
- `iris-feed/` reader — one-way content channel (built)
- Open-Meteo weather + geocoding + `calculate_distance` with the Tucker base — already wired

## What dccar wants Artemis to use directly: **the HermesKB index**

Iris's knowledge base is a local SQLite FTS5 database. Artemis may call it **read-only** via the stable CLI — this is the "brain" query path (Iris stays the brain; Artemis renders and asks):

```rust
// KB query — read-only, no credentials, stdout JSON
// binary: C:\Users\dccar\HermesKB\venv\Scripts\python.exe
// script: C:\Users\dccar\HermesKB\kb_search.py
//
// subcommands (all JSON on stdout):
//   search "<query>" [--corpus books|notes] [--folder X] [--n 12]
//   note "<name substring>"                       -> full vault note
//   get <doc_id> <page>                           -> one book page verbatim
//   pages <doc_id> <from> <to>                    -> page range (max 60)
//   read <doc_id> [--max 400000]                  -> whole document text
//   code "<query>" [--proj <ProjectName>] [--n 12] -> search 3,275 source files
//   list [--folder X] [--title X] [--author X]    -> catalog browse
//
// Example: "what do my books say about maat"
//   kb_search.py search "maat moral" --corpus books --n 5
//   -> {"query":..., "total_hits":{"books":315,"notes":23}, "results":[{doc_id,name,folder,page,snip,corpus,path}...]}

const KB_PY: &str = r"C:\Users\dccar\HermesKB\venv\Scripts\python.exe";
const KB_CLI: &str = r"C:\Users\dccar\HermesKB\kb_search.py";
```

**Suggested Artemis tool: `query_iris_knowledge(query, corpus, n)`** — spawn `KB_PY KB_CLI search <query> --corpus <corpus> --n <n>`, parse stdout JSON, return the results to the model. Read-only, no shell interpolation of user input (pass args as argv, not through a shell). This gives Artemis direct "what do my books/notes/code say" power with zero new credentials.

## Ground rules (from dccar, standing)

1. **Claude never gets server/Hermes credentials** — no tokens, no `.env` contents, no `hermes` CLI auth. All Hermes-side access from Artemis goes through the *already-built* `call_hermes_agent` bridge or the read-only KB CLI above.
2. **Privacy mode is unchanged**: privacy-mode content never reaches Hermes, the KB, or the network layer.
3. **Read-only over the KB**: never write to `library.db` from Artemis; Iris owns all indexing (`build_index.py`, `build_notes.py`, `build_code.py`).
4. **iris-feed/**: Artemis reads, never writes/deletes (Iris owns rotation).
5. Never delete anything in `Projects\` without asking dccar (standing rule).

## Useful KB one-liners for the dashboard

- Daily spark source: `kb_search.py search "camus absurd" --corpus notes --n 3`
- "What do my books say about X": `search "<x>" --corpus books --n 5` then `get <doc_id> <page>`
- Project insight: `code "websocket debate" --proj Invicta`
- Fight IQ (Mal's system): `search "outside foot orthodox" --corpus books --folder MMA`