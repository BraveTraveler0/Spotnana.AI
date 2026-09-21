# IRIS → CLAUDE: Android APK port — what you need to know before you start

**From:** Iris (data feeds) · **To:** Claude (lead dev, Artemis) · **Priority:** high — Dominus wants Artemis on his phone
**Scope note:** I checked the repo first — these are facts from `src-tauri/src/lib.rs`, `src/app/App.tsx`, `Cargo.toml`, not generic advice. Finish the event-cards brief (`IRIS-BRIEF-event-cards.md`) first if it isn't done; mobile renders the same cards.

## The good news

You're on **Tauri 2.11.2** — Android is a first-class target (`tauri android init`, no rewrite). The Vite frontend is shared as-is, and the responsive/390px work you just landed is exactly the prep this needed. This is a shell port, not a rewrite.

## 1. Hardcoded Windows paths will break on Android — the big one is the feed

`lib.rs` has:

```rust
const IRIS_FEED_DIR: &str = r"C:\Users\dccar\OneDrive\Desktop\Projects\Artemis\iris-feed";
```

That's the entire daily dashboard's data source (latest.json + checkoffs.jsonl). On a phone there is no `C:\Users\dccar` and no OneDrive. Same class of problem: the Hermes bridge (`home_dir()/bin/hermes.exe`, `C:\hermes`, `%APPDATA%`/`%LOCALAPPDATA%` env reads — all empty on Android), and `Goals.md` pointing at `OneDrive\Documents\Ma'at\...`.

**The architecture decision you need to make (and tell me):** how does the phone get the feed? Options: (a) pull `latest.json` + checkoffs over the **Hermes gateway** you already wired (it does start/steer/stop over `/v1/runs` and has a Settings URL/key section — same transport could expose feed read + checkoff POST), (b) a synced copy (Syncthing/OneDrive on Android), or (c) read-only subset bundled at build time. My vote is (a) — one channel, already authenticated, works over Tailscale away from home. Whatever you pick, **keep `latest.json` as the canonical Iris contract** so the desktop app and phone render identical data.

## 2. Desktop-only capabilities need gating, not porting

- `tray-icon` is in the Cargo features — desktop-only; gate with `#[cfg(desktop)]` or the Android build fails.
- Anything using `std::env::var("APPDATA"/"LOCALAPPDATA")` — gate or replace with Tauri's `app_data_dir()` (which Tauri maps correctly per-platform; your existing `app_data_dir()` calls will follow Android app-storage automatically).
- `call_hermes_agent` / hermes.exe bridge: doesn't exist on the phone — route those calls through the gateway API instead, or hide the feature on mobile.
- The knowledge-vault browser (`DEFAULT_KNOWLEDGE_PATHS` in `App.tsx` hardcodes `C:\Users\...` Ma'at paths) — Android scoped storage can't see those; hide the file-browser on mobile or make it gateway-served.
- FYI that App.tsx default also lists the **stale** vault path (`OneDrive\Documents\Ma'at`) before the live one — per Iris memory, `C:\Ma'at` is the live vault; fix the order while you're in there (desktop bug, free fix).

## 3. Build hygiene: do NOT let Gradle run inside OneDrive

The repo lives in OneDrive (`Projects\Artemis`). `tauri android init` drops `src-tauri/gen/android` with a Gradle daemon, and `target/` grows by gigabytes — OneDrive sync-lock on Gradle's churn is misery (file locks, hydration lag, sync storms; Windows MAX_PATH on top). Recommend: clone/worktree to a local path (e.g. `C:\build\artemis`) for Android builds, or at minimum exclude `src-tauri/gen` and `target` from OneDrive sync before you init. Also budget for setup: JDK 17, Android SDK + NDK, `rustup target add aarch64-linux-android` — none of it is installed yet on this machine.

## 4. Product requirements from Dominus's setup (don't improvise these)

- **Privacy mode is sacred:** Artemis's network-layer gate must come along to mobile, and the ONLY allowed LLM endpoint is **horus's Ollama at `100.94.158.103:11434` over Tailscale** (Ollama Cloud was cancelled 2026-09-20; horus is the only valid privacy-mode brain). Phone needs Tailscale installed/logged-in for privacy mode to work — show a clear "offline/unreachable" state when it can't reach horus. Never substitute a cloud endpoint on mobile, even as a fallback.
- **Sideload, not store:** APK is for his phone only — a signed release APK (self-signed keystore) or debug APK is fine; no Play store plumbing, no signing ceremony beyond a keystore he can keep.
- **Event cards rule still applies on mobile:** every event card shows when · venue + part of town · who hosts · cost — same as the desktop brief.
- His phone is Android (he said "apk"); assume a modern mid-range — but keep the 390px layouts you already built as the baseline.

## 5. What I'll do on my side

Feed contract unchanged — if you go gateway-transport for the feed, tell me the exact endpoints you want and I'll serve them. Checkoffs from the phone go back through the same channel (they already have a JSONL contract in TASKS-CONTRACT.md).

## Verification before you call it done

Same discipline as the desktop: `tauri android build` success is NOT done — install the APK, open it, verify: daily panel renders latest.json data (through whichever transport you chose), one insight card per insight, event cards show area/cost, check-off round-trips, and the app behaves with Tailscale off (graceful offline state, not a blank screen). Report back in the usual form — what changed, what to verify — and I'll relay to Dominus.

— Iris