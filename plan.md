# Parity — Development Plan

**Parity** is a competitive-intelligence SaaS dashboard: crawl e-commerce stores,
save their product catalogues as snapshot history, and compare them against your
own store — prices, new/removed products, and changes over time.

Stack: TanStack Start + React 19 + Tailwind v4 (`frontend/`) · Express + MongoDB
(`backend/`) · custom generic web crawler (Node-only TS, `src/lib/crawler/`).

Verification loop for every change: `npx tsc --noEmit` → `npm run lint` → `npm run build`
(currently clean: 0 errors, 3 pre-existing shadcn warnings).

---

## ✅ What we've done so far

### Crawler engine (`frontend/src/lib/crawler/`)
- [x] Generic engine refactor — `core/` (http, queue, politeness, checkpoint),
      `discover/` (sitemap + html-crawl + platform), `extract/` (jsonld,
      microdata, opengraph, html-heuristics, mapper), `adapters/` (shopify).
- [x] Tiered extraction: Shopify JSON → JSON-LD → OpenGraph/microdata → HTML heuristics.
- [x] Dual discovery: sitemap walk + HTML BFS crawl (category links, product-URL heuristics).
- [x] SQLite checkpointing — crash-safe incremental saves, skip-unchanged on re-runs.
- [x] Politeness: robots.txt respect + crawl-delay, adaptive throttle (429 backoff),
      bounded per-host concurrency.
- [x] Platform detection (robots.txt markers → generator meta → asset fingerprints),
      robots.txt status + crawl-delay captured per crawl.
- [x] **Verbose site intelligence** — detection now reports platform **kind** (store vs
      corporate site), CMS/builder/SEO plugin/server stack (e.g. WordPress · Elementor ·
      Rank Math · Apache·PHP 8.2), homepage analysis (product-link count, store-vs-corporate,
      external store links like a `shop.` subdomain), multi-candidate sitemap discovery
      (robots.txt `Sitemap:` directives → `/sitemap.xml` → `/sitemap_index.xml`, HTML-redirect
      detection), and a per-run **discovery log + findings/suggestions** (e.g. "this looks
      like a corporate site — crawl its linked store instead") surfaced live in the Sources
      panel, the Store profile card, **and the Store catalogue page** (`DiscoveryLog`).
- [x] **Discovery breadth** — WordPress core sitemap indexes now resolve to their
      product post-type files (`wp-sitemap-posts-product-*.xml`) and are trusted wholesale
      (covers WooCommerce `/shop/<cat>/<product>/` permalinks that no URL pattern can
      safely classify); default sitemap candidates no longer double-slash from trailing
      `/` origins; HTML crawl follows `/product-category/` + `?product_cat=` categories
      and multi-segment `/shop/…` product links. Verified live: `atonline.com.pk` went
      from 0 → **120 products** via `wp-sitemap.xml`.
- [x] **Price extraction hardening** — WooCommerce/Yoast nest the offer price under
      `priceSpecification` → `UnitPriceSpecification`; the JSON-LD extractor now resolves
      it (plus currency and thousands separators like `"1,400"`), skips unparseable
      offers instead of saving fake 0s, and never treats `price: 0` (free items) as
      missing. Verified live: `fitnessdepot.pk` prices now extract (1400 / 300 / 4900 PKR
      vs all-0 before).

### Crawl jobs & persistence
- [x] Job/poll server functions (`startCrawl` / `getCrawlProgress`), live
      discovery diagnostics, fetch-phase ETA, `?job=` cross-tab reconnect.
- [x] Recurring schedules (1h/6h/daily/weekly) with cancel (in-memory, reset on restart).
- [x] Results persisted to MongoDB (`CrawlResult`), per-origin snapshot history
      (cap 20) with `DELETE` endpoints for one snapshot or a store's history.

### Dashboard pages
| Page | Route | Status |
|---|---|---|
| Overview | `/` | ✅ live stats from saved crawls |
| Sources (Crawler) | `/sources` | ✅ domain-first crawl UI, config, live progress, store profile, scheduler |
| Saved crawls | `/crawls` | ✅ history hidden by default + Show/Hide, "+N new" badges, expandable rows, Re-crawl, delete/clear |
| Store catalogue | `/stores/$origin` | ✅ full searchable + sortable product table, snapshot picker, **All-snapshots union view with per-product price sparklines**, per-snapshot price trails, Delete store, discovery log, paginated rows |
| Competitors | `/competitors` | ✅ empty-by-default slot flow (your-website picker + 4 competitor slots), per-slot comparison panels, fuzzy matching **on by default**, paginated tables |
| Matched products | `/products` | ⚠️ basic table — needs the matching layer |
| Pricing | `/pricing` | ✅ real market trend + price index + biggest movers from snapshot time-series |
| Catalogue gaps | `/catalogue` | ⬜ empty state — needs your catalogue + matching |
| AI insights | `/insights` | ⬜ empty state — needs the insight engine |
| Alerts | `/alerts` | ⬜ empty state — needs the alert engine |
| Reports | `/reports` | ⬜ empty state — needs the report generator |

### Auth & backend
- [x] Real JWT auth (login/register/profile) against Express + MongoDB, demo user seeded.
- [x] `dataController` derives competitors/products/stats from real `CrawlResult` data
      (demo dataset deleted — no fabricated numbers anywhere).
- [x] `Competitor` model (add/delete) + `MyStore` singleton (set your store URL).

### Engineering quality
- [x] DRY refactor: shared `StockBadge`, `ProductCell`, `CrawlStatsGrid`,
      `CrawlDiffSummary`, `StateCard`, `formatPrice`/`formatDuration` — removed
      ~6× duplicated price formatting, stock badges, stats grids and diff blocks.
- [x] Dead code removed (unused `EmptyState`, `ui/toggle.tsx`, unused re-export).
- [x] `AGENTS.md` kept in sync; docs updated for every feature.

---

## 🔜 What's next (priority order)

### 1. Price history & Pricing page (recommended next)
- [ ] Backend endpoint: flatten products across an origin's snapshots into a
      per-product price time-series.
- [ ] Store catalogue page: per-product price sparkline / "cheapest ever" /
      "current vs first seen" (small inline chart, recharts already installed).
- [ ] Pricing page: real positioning — market average/median per product,
      your-price vs competitor distribution, biggest movers.
- [ ] Backfill note: series only spans existing snapshots; future crawls extend it.

### 2. Product matching layer
- [ ] Server-side matcher, priority GTIN > SKU > URL slug > fuzzy name+brand
      (reuse the client-side `compareStores` fuzzy logic as the fallback).
- [ ] Matched products page (`/products`): your catalogue vs each competitor —
      match status, price gap, availability.
- [ ] Prerequisite for Catalogue gaps and "your price" columns everywhere.

### 3. My-store catalogue import
- [ ] "My store" currently stores only the origin — add a real catalogue source:
      crawl the store (existing engine) or CSV/JSON upload.
- [ ] Store the catalogue in MongoDB (`MyCatalogue` / extend `MyStore`).
- [ ] Unlock Catalogue gaps page (categories we don't sell, brand coverage,
      price-positioning charts).

### 4. Alert engine
- [ ] Compute alerts from per-snapshot diffs we already produce: price drops
      (with % + amount), stock changes, new / removed products.
- [ ] Alerts page (`/alerts`): live feed, unread badge, dismiss.
- [ ] Optional: email/webhook delivery later.

### 5. Engineering hygiene
- [x] Unit tests for pure logic: **pagination is done** (`usePagination` +
      `PaginationBar` on store catalogue, competitor comparison and matched
      products tables — full catalogues render in fixed-size pages).
- [ ] Unit tests for pure logic: `compare.ts`, `computeCrawlDiff`, `format.ts`,
      `normalizeOrigin` (vitest — none exist yet).
- [ ] Auth on `/api/data/*` routes (currently open).
- [ ] Backend audit: same dead-code/redundancy pass as the frontend.

### 6. Crawler breadth — tiered unlocks for JS-rendered / bot-protected stores

The generic engine already covers stores with readable sitemaps/HTML
(Shopify, WooCommerce, Magento, WordPress). These tiers are the ladder into
the rest. **Execution order (decided): Tier 1 → Tier 3 → Tier 2 → Tier 4.**

- [ ] **Tier 1 — Playwright browser fallback** *(next)*: lazy-loaded headless
      Chromium for JS-rendered stores (Nuxt/SPA like `techmen.com.pk`). Render
      the DOM, then run the existing extractors on the rendered HTML. Opt-in
      per crawl; `PLAYWRIGHT_BROWSERS_PATH` env. **Unlocks: techmen, JS stores.**
- [ ] **Tier 3 — Per-site adapters**: WooCommerce native (`/wp-json/wc/v3`),
      BigCommerce, then enterprise adapters for the stores that matter (Nike's
      `/t/<slug>-<id>` pattern + product API, Zara's internal product API).
      Far more reliable than HTML scraping on custom platforms. **Unlocks: nike (partial).**
- [ ] **Tier 2 — Residential/rotating proxies + browser fingerprinting**: the
      actual blocker on dawlance/techmen/teslalaptops (403 IP blocks) and zara
      (Akamai challenges even real browsers). Route crawler traffic via a
      residential proxy provider to fix IP reputation. **Unlocks: dawlance,
      techmen, teslalaptops.**
- [ ] **Tier 4 — Commercial scraping platform**: Apify (pre-built Nike/Zara/
      retail actors + proxy infrastructure) or retailer affiliate feeds for the
      hardest targets (zara, nike) where in-house effort isn't worth it.
- [ ] Identity dedupe across stores (GTIN > SKU > slug > fuzzy).

### 7. Insights & Reports
- [ ] Insight engine: top movers, biggest gaps, price-drop summaries → `/insights`.
- [ ] Report generator: per-store / per-category PDF/CSV exports → `/reports`.
- [ ] Export CSV button on the Store catalogue page.

### 8. Productionize
- [ ] Reverse proxy in front of the backend for prod (`/api` proxy is dev-only).
- [ ] Deployment via Nitro (`dist/server`), host config, CI pipeline.
- [ ] Error/loading instrumentation + skeleton states audit.
