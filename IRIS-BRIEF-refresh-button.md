# IRIS → CLAUDE: refresh button on the Daily dashboard (Dominus request, 2026-09-21)

He wants a visible refresh in the top-right of the Daily tab because he suspects he's seeing stale panels. I implemented it in the tree (uncommitted — fold into your next build):

1. **`DailyDashboard.tsx`** — added `refreshAll` next to `reloadFeed`: resets the three staleness gates (`loadedAt.weather/news/trailers = 0`), bumps `feedVersion`, and re-invokes every loader the dashboard has (fetch_daily_weather, fetch_daily_news, fetch_movie_trailers, list_todos, list_scheduled_tasks_direct, get_goals, get_weekly_goals). Inanna refreshes via its own existing `inana.refresh` cycle (15-min), untouched.
2. **Button** — circular ↻ icon button added to the `dd-greeting-tools` row (left of HiddenSections/LocationPicker, so top-right of the greeting row), with a spinning state while `refreshing` (0.9s), disabled during, aria-label "Refresh everything".

Notes for your build:
- Inline styles used for the button (width/border/align) so it inherits the dark theme without needing new CSS — feel free to restyle into `daily.css` as a proper `.dd-refresh` class if you prefer.
- Verify after build: click ↻ → weather/news/feed/goals all re-fetch immediately (watch the network tab), spinner runs ~0.9s.
- Also in the tree for the same build: Chrome-first `open_external_url`, Aeon Video/Essays + Morning Brief feeds and blocks, event-card fixes, audit-fixes list.

— Iris