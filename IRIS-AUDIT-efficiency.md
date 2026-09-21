# IRIS AUDIT — Artemis efficiency report (2026-09-21, ~01:45)

Read-only audit of the current tree. Full evidence below; act on these AFTER tonight's event-card/Inanna push lands.

**Measured:** dist = 1,005 KB (index JS 802 KB, CSS 152 KB) · largest source = src-tauri/src/lib.rs 291 KB / 7,005 lines · setInterval sites = 3 (DailyDashboard 60s, useInana 15min, usePhoneFeed 60s) · **src-tauri/target = 27.5 GB inside OneDrive sync scope** · release exe 19 MB unstripped · audit_log.jsonl unbounded.

## Findings

1. **[high] typescript missing from devDependencies** — no typecheck can run (package.json:74-81, no tsc in scripts). Fix: `npm i -D typescript@^5` + `"typecheck": "tsc --noEmit"` script.
2. **[high] Entire shadcn/ui kit unreachable + ~30 unused heavy deps** — all 45 files in src/app/components/ui/ have zero importers; @mui/material, @mui/icons-material, @emotion/*, date-fns, react-dnd, react-router, ~20 @radix-ui packages installed for nothing (live code uses only lucide-react, motion, recharts, @tauri-apps/*). Fix: delete src/app/components/ui/ + npm rm the dead packages.
3. **[high] Per-SSE-token re-renders the whole 1,835-line App** — App.tsx:918 setState on every stream chunk; DailyDashboard stays mounted-hidden (App.tsx:1222) with no React.memo, so every token repaints invisible charts/panels. Fix: buffer deltas (~50ms flush) + React.memo DailyDashboard.
4. **[med] Phone-feed sync retries every 60s with no backoff** — usePhoneFeed.ts:58; Tailscale down = infinite 60s TCP attempts. Fix: reuse useInana's retryDelay pattern (20s→5min).
5. **[med] 60s feed poll does blocking OneDrive reads** — get_iris_feed (lib.rs:2558) and get_weekly_goals (lib.rs:2771) are sync fs::read_to_string on OneDrive files, invoked every 60s; lib.rs:925-935 itself documents OneDrive placeholder reads can hang forever. Fix: make async, route through read_content_with_timeout/spawn_blocking.
6. **[med] audit_log.jsonl unbounded** — append-only, no rotation (lib.rs:44-59); read_audit_log loads the whole file to return 100 lines. Fix: rotate at 5MB + tail-read.
7. **[med] 27.5GB src-tauri/target inside OneDrive** — the direct cause of du hangs and sync churn. Fix: CARGO_TARGET_DIR to a non-OneDrive path or exclude from OneDrive sync. (Also the Android-port brief already says build from a local clone.)
8. **[med] Single 802KB JS bundle** — no manualChunks; recharts/motion statically imported, chart code parses on every startup (and would on Android). Fix: manualChunks + lazy() the DailyDashboard.
9. **[low] 19MB unstripped release exe** — no [profile.release] in Cargo.toml. Fix: strip = true, lto = "thin".
10. **[low] react/react-dom only optional peerDeps** — builds resolve only via auto-peer-install. Fix: move to dependencies.

**Priority order for Dominus:** 7 (disk/sync pain now) → 1, 2 (hygiene) → 3 (perceived speed while chatting) → 5, 4, 6 (reliability under failure) → 8, 9, 10.

— Iris