# IRIS → CLAUDE: Audit fixes — Artemis + MarketGenius (Dominus-approved)

**From:** Iris · **To:** Claude (lead dev) · **Priority:** after tonight's must-dos
**Gate:** the event-cards rebuild + Inanna never-logout acceptance (IRIS-BRIEF-event-cards.md Bugs 1–5) come FIRST. Nothing below starts until that is committed and verified. Full evidence for everything below is in `IRIS-AUDIT-efficiency.md` in each repo root (read those first — file:line citations included).

## Artemis — fix in this order

1. **Get src-tauri/target out of OneDrive (27.5GB of build artifacts syncing forever; causes the file-scan hangs).** Set `CARGO_TARGET_DIR` to a local non-OneDrive path (e.g. `C:\build\artemis-target`) in your build environment, or exclude `src-tauri/target` from OneDrive sync. Do this FIRST — it speeds up every later build.
2. **Add typescript + a typecheck script** — `npm i -D typescript@^5`, `"typecheck": "tsc --noEmit"` (package.json devDeps has no typescript today; no typecheck has ever run).
3. **Delete the dead UI kit** — all 45 files in `src/app/components/ui/` have zero importers; `npm rm @mui/material @mui/icons-material @emotion/react @emotion/styled @popperjs/core react-popper date-fns react-dnd react-dnd-html5-backend canvas-confetti react-responsive-masonry react-router` + the ~20 unused @radix-ui packages. Keep lucide-react, motion, recharts, @tauri-apps/*. Verify build + app still runs.
4. **Stream render fix** — App.tsx:918 setStates per SSE token and re-renders the whole 1,835-line App incl. the mounted-hidden DailyDashboard. Buffer deltas (flush ~50ms or rAF) + wrap DailyDashboard in React.memo.
5. **Backoff on phone-feed sync** — usePhoneFeed.ts:58 retries every 60s forever when Tailscale is down; reuse useInana's retryDelay pattern.
6. **Un-hang the 60s feed poll** — get_iris_feed (lib.rs:2558) and get_weekly_goals (lib.rs:2771) do blocking fs reads on OneDrive files your own comments call a hang risk (lib.rs:925-935). Make them async via read_content_with_timeout/spawn_blocking.
7. **audit_log.jsonl rotation** — cap ~5MB on append, tail-read in read_audit_log instead of loading the whole file.
8. **Bundle/exe slimming** — manualChunks for recharts/motion + lazy() the DailyDashboard; `[profile.release] strip = true, lto = "thin"` (19MB exe → smaller); move react/react-dom from optional peerDeps into dependencies.

## MarketGenius — fix in this order

1. **askAi retry must not re-run real tools (cost + duplicate-side-effects bug)** — aiController.js:2114-2128 recreates the toolBudget and re-runs tools that already fired (duplicate ContentDrafts, duplicate real posts). Persist attempt-1 tool results; retry only the synthesis call, or accept a tool-bearing result as-is.
2. **Stop spending gpt-5.6-sol on image picking** — mediaPicker.js:124 uses TEXT_MODEL for single-label classification; the keywordRank backstop (mediaPicker.js:56-69) already works. Route to OPENAI_VISION_MODEL or drop the call.
3. **Trim the askAi system prompt** — measured 76,194 chars (~19k tokens) re-sent every tool round/retry. Cap the suggestion/campaign/business-note blocks; dedupe positioning text; reuse the messages object across rounds.
4. **workspaceScanRunner: stop force-bypassing the signal fingerprint** — workspaceScanRunner.js:23,55,60 force:true defeats the SHA-256 cache (aiController.js:2811). Omit force in the runner; keep force only for the manual refresh endpoint.
5. **Evidence panel caching** — ~10 uncached Meta/GA4/Ads/Vercel calls every 15min per open tab; add a 30–60min server cache (pattern: aiController.js:249-273) or drop the client interval to hourly.
6. **Media Library query** — .lean() + projection + Mongo-side text filter + pagination (mediaLibraryController.js:95-101); 23MB MP4 out of the bundle (lazy/static-host); fs.promises in mediaStorage.js:31-34; small concurrency pool for folder-upload vision calls.

**MarketGenius constraints:** single-user personal app — no behavior changes to the writing pipeline (angle → Carolina → lint stays untouched); after deploy, verify one draft end-to-end (~$0.04 baseline via terra) and that Inanna's dashboard still loads. Deploys go through the usual Render git flow — nothing gets pushed there without Dominus seeing the change list first.

Report back in the usual form per repo: what changed, what to verify. Dominus reads everything through me.

— Iris