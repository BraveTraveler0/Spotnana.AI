# IRIS → CLAUDE: links now open in Chrome (Dominus order, 2026-09-21)

Also in the tree, my edit to **your** InsightFeed.tsx + daily.css (small, flagged per the standing exception): on "Add to tasks", the card now **fades and collapses** (0.55s opacity/translate + max-height collapse, class `dd-post-settling`, then `onDismiss` removes it) — Dominus's rule: adding to tasks ends the card's life in this feed. If you'd rather implement it differently, keep the behavior, change the mechanics.

I edited `open_external_url` in `lib.rs` (uncommitted): on Windows it now launches Chrome explicitly (both standard install paths checked, falls back to `rundll32` only if Chrome is missing) — his saved passwords live in Chrome, and rundll32's default-handler pick wasn't landing there consistently. Android path untouched (system handler is correct on phone). Carry into your next build + verify: click a recipe/news link in the running app → opens in Chrome with his profile.

— Iris

# IRIS → CLAUDE: Aeon mini-docs in the Ideas section (Dominus request, 2026-09-21)

He loves the Aeon content in the Daily dashboard and asked for more of the video/mini-documentary side. I made two small edits in the tree (they're uncommitted, fold them into your next build):

1. **`src-tauri/src/lib.rs` NEWS_FEEDS** — added `("https://aeon.co/videos/feed.rss", "Aeon Video", "Ideas", 4)` right after the existing Aeon essays entry (essays bumped 3→4). The videos feed is live, RSS 2.0, clean `<item>`s with title/link/pubDate and an `<img>` inside the description HTML — your `feed_item_image` fallback (first image in description) already picks those up. Verified the feed returns 200 with items today.
2. **`DailyDashboard.tsx`** — added a second Ideas block: `{ style: 'compact', topic: 'ideas', label: 'Ideas', categories: ['Ideas'], count: 3, min: 2 }` after the existing tall Ideas block, so Aeon essays AND mini-docs both surface (the round-robin `interleaveBySource` will alternate them).

When you build next: verify the Ideas section shows 4 items (1 tall + 3 compact), sourced from both Aeon and Aeon Video, each with a thumbnail. If Aeon Video items are missing images, check `first_image_in_html` against their description markup (img src is `images.aeonmedia.co/...`). Note: the lint pass on lib.rs is pre-existing edition noise (rustc defaulting to 2015 standalone) — cargo builds fine with the project's edition; don't chase it.

Also please carry these open threads: IRIS-BRIEF-audit-fixes.md (Artemis section, after Inanna acceptance), and Inanna still points at localhost:8080 in Dominus's inana.json — see my earlier note; he needs the connect flow to offer the Render URL (https://marketinggenius-backend-server.onrender.com) as default and save his password to the keyring.

— Iris