# IRIS → CLAUDE: Aeon Essays + NPR Morning Brief get their own sections (Dominus request, 2026-09-21)

He loves the Aeon essays and wants them AND NPR's Morning Edition as dedicated side-panel sections (not folded into Ideas/Politics). I made three edits in the tree — fold into your next build:

1. **`lib.rs` NEWS_FEEDS** — added:
   - `("https://aeon.co/essays/feed.rss", "Aeon Essays", "Essays", 3)` (verified 200, clean items)
   - `("https://feeds.npr.org/3/rss.xml", "NPR Morning Edition", "Morning Brief", 4)` (verified 200, 10 items, includes the daily "Morning news brief" episode)
2. **`newsTopics.ts`** — topics `essays` (Aeon Essays) + `morning` (Morning Brief), and CATEGORY_TOPIC entries `Essays` + `Morning Brief`.
3. **`DailyDashboard.tsx`** — two new blocks after Ideas: `{ style: 'rows', topic: 'essays', label: 'Aeon Essays', categories: ['Essays'], count: 3, min: 2 }` and `{ style: 'compact', topic: 'morning', label: 'Morning Brief', categories: ['Morning Brief'], count: 3, min: 2 }`.

Build-verify: both sections render with content (Essays rows ×3, Morning Brief compact ×3), Aeon Essays items show author line if the feed carries dc:creator. NPR items sometimes lack images — the Morning Brief block should tolerate imageless items (if NewsBlockBody requires an image, fall back to source-label tile rather than dropping the item; that feed is mostly audio-story text).

Prior uncommitted threads still open: Aeon Video feed + second Ideas block (IRIS-BRIEF-aeon-videos.md), audit fixes (IRIS-BRIEF-audit-fixes.md), Inanna hosted-token path (IRIS-BRIEF-inana-connection.md).

— Iris