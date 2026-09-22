# IRIS → CLAUDE: Inanna is LINKED to hosted — RESOLVED (2026-09-21 ~11:30)

Supersedes the root-cause note below. The blocker was a stale JWT_SECRET — Dominus's first paste didn't match the deployed server; the current one verified. `inana:token --hosted` ran clean:

- `inana.json` now: **api_url https://marketinggenius-backend-server.onrender.com** · web_url https://marketinggenius-nu.vercel.app · darrienccarter@gmail.com · 10-year owner token
- Independently verified: `/api/products` returns **['AonCreative', 'Wanderwork']** with live Meta data (wanderwork $105.27/30d)
- Stripe is NOT connected yet on hosted (`/api/data/stripe/summary` → "add it in Settings → Credentials") — expected; Meta numbers will show, revenue stays ghosted until he links Stripe inside Inanna's Settings → Credentials
- hosted.env was wiped by the script as designed

**Acceptance test now lives with Dominus:** restart Artemis → Inanna's Insight shows the live numbers with no login prompt. The 10-year token holds the never-logout order across redeploys.

Your asks (still standing):
1. **Never silently fall back to localhost** — surface a "wrong server" state if api_url is local/unreachable; "no ad account or Stripe" must never appear for an auth/server failure.
2. Carry the uncommitted tree into your next build: Aeon Video feed + second Ideas block (IRIS-BRIEF-aeon-videos.md), Aeon Essays + NPR Morning Brief sections (IRIS-BRIEF-essays-morning.md), audit fixes (IRIS-BRIEF-audit-fixes.md).

---

# (ARCHIVE) Root cause, 2026-09-21 ~11:00

Dominus showed me the live dashboard: **the deployed Inanna HAS data** — https://marketinggenius-nu.vercel.app/inanna/today?product=wanderwork shows Meta Ads Live: $105.27 spend, 11,615 impressions, 736 clicks, CTR 6.34%, last 30 days. The pipeline works in the browser. Artemis showed "connected but no data" because:

1. `inana.json` pointed at **`http://localhost:8080`** (local dev API, not running) — not the Render backend.
2. The saved token was minted by the LOCAL instance's JWT_SECRET → hosted correctly returned **401** (probed directly).
3. NO ad-account/Stripe problem existed on hosted — the Vercel dashboard proved the data flows there. The "no ad account" card message was misleading for an auth/server failure.

Fix executed via your `scripts/inana-token.mjs --hosted` (correct design — verifies the token against the live server before saving, then wipes the secrets from `~/.artemis-inana/hosted.env`).

— Iris