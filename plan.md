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
- [x] **Flat `<category>/<slug>` sitemap taxonomies** — stores whose catalogue is a
      category tree (techmen.com.pk: `/computing/<slug>`, products nested 3–4 levels
      deep) are now recognized: a sitemap URL is treated as a product when it is a
      **leaf** of the sitemap tree (no URL nests under it), sits at depth ≥ 2 under a
      standalone section page, and that section isn't a known non-product/archive base
      (`blog`, `news`, `shop`, `product-category`, `tag`, legal/account pages…).
      Verified live: `techmen.com.pk` went **0 → ~1,900 product URLs** with ~96%
      precision on spread-sampled extraction (JSON-LD yields PKR price + SKU;
      the residual tail is subcategory landing pages that are sitemap leaves).
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
| Matched products | `/products` | ✅ **real matching layer** — your crawled catalogue vs each competitor via `backend/utils/matcher.js` (GTIN > SKU > URL slug > fuzzy name): match method + confidence, your-price / price gap, competitor products you don't carry shown as **Unmatched**; paginated. Honestly empty until your store is set (`/competitors`) and crawled |
| Pricing | `/pricing` | ✅ real market trend + price index + biggest movers from snapshot time-series |
| Catalogue gaps | `/catalogue` | ⬜ empty state — matching layer is live; needs category/brand gap analysis on top of your catalogue |
| AI insights | `/insights` | ⬜ empty state — needs the insight engine |
| Alerts | `/alerts` | ⬜ empty state — needs the alert engine |
| Reports | `/reports` | ⬜ empty state — needs the report generator |

### Auth & backend
- [x] Real JWT auth (login/register/profile) against Express + MongoDB, demo user seeded.
- [x] `dataController` derives competitors/products/stats from real `CrawlResult` data
      (demo dataset deleted — no fabricated numbers anywhere).
- [x] `Competitor` model (add/delete) + `MyStore` singleton (set your store URL).
- [x] **Product matching layer** — `backend/utils/matcher.js` (`matchCatalogues`):
      identity tiers in priority order **GTIN (digits-only) > SKU (alphanumeric) >
      URL slug > fuzzy name similarity**; every product matches at most once with
      `method` + `confidence` (100 for exact, similarity % for fuzzy). The crawler
      persists `sku`/`gtin` on every product (`CrawlResult` schema) so identity
      survives the crawl → Mongo boundary. `dataController` wires it into
      `/api/data/analytics`, `matched-products` and `pricing`: matched rows with
      price gap, unmatched competitor rows, `matchRate` / `onlyYouSell` /
      `onlyTheySell` / `avgPriceGap`, and market stats decoupled from your
      catalogue. Honest empty until a my-store is set and crawled. Fixture test
      `backend/utils/matcher.test.js` (11 checks green, endpoints curl-verified).

### Engineering quality
- [x] DRY refactor: shared `StockBadge`, `ProductCell`, `CrawlStatsGrid`,
      `CrawlDiffSummary`, `StateCard`, `formatPrice`/`formatDuration` — removed
      ~6× duplicated price formatting, stock badges, stats grids and diff blocks.
- [x] Dead code removed (unused `EmptyState`, `ui/toggle.tsx`, unused re-export).
- [x] `AGENTS.md` kept in sync; docs updated for every feature.

---

## 🔜 What's next (priority order)

### 1. Price history & Pricing page — done
- [x] Backend time-series — `computePriceHistory` flattens an origin's
      snapshots into per-product price series (drives Pricing + dashboard).
- [x] Store catalogue page — All-snapshots view has per-product price
      sparklines + price range + "seen in N snapshots".
- [x] Pricing page — market/cheapest/your-store trend, market-relative price
      index, biggest movers, all derived from saved snapshots.
- [x] Backfill note — series only spans existing snapshots; future crawls
      extend it.

### 2. Product matching layer — done
- [x] Server-side matcher (`backend/utils/matcher.js`), priority GTIN > SKU >
      URL slug > fuzzy name (token overlap + containment + edit distance,
      same machinery as the client-side `compareStores`).
- [x] Matched products page (`/products`): your catalogue vs each competitor —
      match method + confidence, price gap, availability; unmatched competitor
      rows listed as **Unmatched**.
- [x] Prerequisite for Catalogue gaps and "your price" columns everywhere —
      live now; the `/catalogue` gaps analysis still needs building on top.

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
the rest. **Execution order: Tier 1 → Tier 3 → Tier 2 → Tier 4 — Tiers 1–3
are done, so only Tier 4 (commercial platform) remains.**

- [x] **Tier 1 — Playwright browser fallback — done** (`core/browser.ts`):
      lazy headless renderer preferring system Chrome → Edge → bundled
      Chromium, wired through `core/http.ts` (`renderWithBrowser` re-renders
      JS-shell pages — `#__nuxt`/`#__next`/`#root` + JS bundle, or a
      nearly-empty page), engine closes the shared browser on finish, opt-in
      per crawl via the Sources **Browser rendering** toggle
      (`useBrowser` → `CrawlRunInput` → job → schedule);
      `PLAYWRIGHT_BROWSERS_PATH` env supported. **Unlocks: techmen, JS stores.**
- [x] **Tier 3 — Per-site adapters**: **WooCommerce native (`/wp-json/wc/v3`)
      — done** (`adapters/woocommerce.ts`: one-request probe → a public API
      is auto-picked for discovery (paginated walk, `X-WP-Total`) + structured
      per-product parse (SKU/GTIN/price/stock) in the fetch loop; an
      auth-required/unavailable API is recorded honestly in
      `discovery.wooCommerce` + findings and the crawl falls back to
      sitemap/HTML). **BigCommerce Storefront API (`/api/storefront/catalog/products`)
      — done** (`adapters/bigcommerce.ts`: probe → paginated walk (`limit=250`,
      `pagination.total_pages`) collecting URLs + a URL→id map, per-product JSON
      fetch by id in the fetch loop (SKU/price/stock), honest
      `discovery.bigCommerce` outcome + findings). Enterprise adapters
      (Nike `/t/…`, Zara product API) remain. **Unlocks: nike (partial).**
- [x] **Tier 2 — Residential/rotating proxies — done** (`core/http.ts` +
      Sources **Residential proxy** field): an opt-in proxy gateway URL flows
      `CrawlRunInput.proxy` → `CrawlConfig.proxy` → every HTTP request via
      undici's `ProxyAgent` (`dispatcher`), including the robots.txt fetch
      (same origin), so provider-side IP rotation fixes reputation 403s.
      Same politeness / retries / robots logic as direct fetches; the URL is
      server-memory / browser-localStorage only — never persisted to crawl
      results or logs (job params carry a boolean for the UI badge). Oxylabs /
      Bright Data / Smartproxy gateway URLs all work. Browser
      fingerprinting/stealth is a separate concern — zara's Akamai challenges
      still need real-browser + residential combined.
      **Unlocks: dawlance, techmen, teslalaptops (IP blocks).**
- [ ] **Tier 4 — Commercial scraping platform**: Apify (pre-built Nike/Zara/
      retail actors + proxy infrastructure) or retailer affiliate feeds for the
      hardest targets (zara, nike) where in-house effort isn't worth it.
- [x] Identity dedupe across stores (GTIN > SKU > slug > fuzzy) — done via the
      server-side matching layer (`backend/utils/matcher.js`, §2), which matches
      your saved catalogue against each competitor's.

### 7. Insights & Reports
- [ ] Insight engine: top movers, biggest gaps, price-drop summaries → `/insights`.
- [ ] Report generator: per-store / per-category PDF/CSV exports → `/reports`.
- [ ] Export CSV button on the Store catalogue page.

### 8. Productionize
- [ ] Reverse proxy in front of the backend for prod (`/api` proxy is dev-only).
- [ ] Deployment via Nitro (`dist/server`), host config, CI pipeline.
- [ ] Error/loading instrumentation + skeleton states audit.
