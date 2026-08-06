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
| Sources (Crawler) | `/sources` | ✅ domain-first crawl UI, config, live progress, store profile, scheduler, **pause/resume/cancel on the live panel (cancel confirmed via the shared `CancelCrawlDialog`, every action confirmed with a sonner toast)** |
| Active crawls | `/crawler` | ✅ **background-crawler hub** — every in-flight job (queued/claimed/retrying, paused included) + last 15 min finished, polled 2.5s, with per-card Pause / Resume / Cancel (cancel confirmed via dialog; pause/resume/cancel all fire sonner toasts), progress bar, shallow/deep badges, Track links, and a **debug strip with worker id + live HTTP-request count** |
| Saved crawls | `/crawls` | ✅ history hidden by default + Show/Hide, "+N new" badges, expandable rows, Re-crawl, delete/clear |
| Store catalogue | `/stores/$origin` | ✅ full searchable + sortable product table, snapshot picker, **All-snapshots union view with per-product price sparklines**, per-snapshot price trails, Delete store, discovery log, paginated rows |
| Competitors | `/competitors` | ✅ empty-by-default slot flow (your-website picker + 4 competitor slots), per-slot comparison panels, fuzzy matching **on by default**, paginated tables |
| Matched products | `/products` | ✅ **real matching layer** — your crawled catalogue vs each competitor via `backend/utils/matcher.js` (GTIN > SKU > URL slug > fuzzy name): match method + confidence, your-price / price gap, competitor products you don't carry shown as **Unmatched**; paginated. Honestly empty until your store is set (`/competitors`) and crawled |
| Pricing | `/pricing` | ✅ real market trend + price index + biggest movers from snapshot time-series |
| Catalogue gaps | `/catalogue` | ⬜ empty state — matching layer is live; needs category/brand gap analysis on top of your catalogue |
| AI insights | `/insights` | ⬜ empty state — needs the insight engine |
| Alerts | `/alerts` | ✅ **real alerts feed** from `ProductEvent` (price drops/rises with % + amount, new/removed products, stock changes), type filters, server pagination, unread badge + mark-all-read, per-alert dismiss |
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

### 4. Alert engine — done
- [x] Compute alerts from per-snapshot diffs we already produce: price drops
      (with % + amount), stock changes, new / removed products.
- [x] Alerts page (`/alerts`): live feed, unread badge, dismiss.
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

### 9. Scale — 100+ stores · 10k+ products per store (design)

> **Full implementation reference: [`architecture.md`](architecture.md)** —
> concrete schemas, indexes, job-queue design, capacity math, and the
> phased migration. This section is the condensed summary.

**Target:** ~100 e-commerce stores, each with 1k–50k products (~1M product rows
total), crawled on a daily/weekly cadence, compared against your store, with
per-product price history and change detection.

**The bottleneck today (why this is needed):**

- `CrawlResult` embeds the **full product array in every snapshot doc** — 10k
  products ≈ 5–10 MB per document, ×20 snapshots ≈ 100–200 MB per store,
  ×100 stores ≈ 10–20 GB; any read that loads products drags MBs over the wire.
- The matcher's fuzzy pass is O(n·m) and is **already self-limited** above 50k
  pairs (`FUZZY_PAIR_LIMIT` in `backend/utils/matcher.js`). At 10k × 10k it
  would be minutes of sync CPU — it must never run on the request path.
- The crawler lives in the **SSR process** with in-memory jobs/schedules — fine
  for one-off runs, not for 100 staggered sites.
- (Already shipped toward this: `GET /crawl-results?meta=1` returns
  product-count-only summaries, and the client comparison runs chunked/async.)

#### 9.1 Storage — normalize: one row per product, snapshots become metadata

Replace the "one doc per snapshot containing everything" model with a
normalized schema. **Heavy work happens at ingest time** (when a crawl
finishes); reads are cheap indexed lookups:

| Collection | What it stores | Size at scale |
|---|---|---|
| `Store` | One doc per origin: platform/profile, crawl config, cadence, last-crawl stats | 100 × ~1 KB |
| `Product` | **Current state** — one doc per (origin, identity key): indexed `gtin`/`sku`/`slug`, name, brand, category, price, available, url, `firstSeenAt`/`lastSeenAt`/`updatedAt`, capped price-history array | 1M × ~300 B ≈ 300–400 MB (WiredTiger-compressed far less) |
| `Snapshot` | Crawl metadata only — origin, timestamps, stats, product count, **added/removed/changed summary** (no product arrays) | 100 × 10 × ~1 KB ≈ 1 MB |
| `ProductEvent` | Change log rows: added, removed, price change (old→new, %), stock change | ~10–20% of products change/day ≈ 200k rows/day at peak |
| `ProductMatch` | Persisted match pairs (yourProduct ↔ competitorProduct, method, confidence, updatedAt) | one row per matched pair per competitor |

Key moves:

- **Products are stored once, never once per snapshot.** History = `Snapshot`
  metadata + `ProductEvent` rows + the capped price array on each `Product`.
  No duplicated catalogues anywhere.
- **Removed products are soft-deleted** (`lastSeenAt` updated; an index on
  `{origin, lastSeenAt}` makes "currently active" a trivial query) so they stay
  for history but drop out of live views instantly.
- **Price history as a capped array** (~last 90 points, appended only on
  change) gives per-product time series without a billion-row `PricePoint`
  table — ~90 × ~20 B per product even for daily movers.
- Indexes: unique `{origin, identityKey}`; sparse `gtin`/`sku`/`slug` (match
  lookups); `{origin, lastSeenAt}` (active set); `{identityKey, updatedAt}`
  (market aggregation). Single replica set is fine to ~5–10M products;
  shard on `origin` beyond that.

#### 9.2 Fetching — incremental, API-first (least compute)

- **Move the crawler into worker processes.** A DB-backed job queue (one job
  per store per run) fed by the scheduler; a small worker pool (2–6 processes)
  pulls jobs under a global politeness budget. The SSR process only submits
  jobs and reports status.
- **API-first extraction (already built — make it the default):** a public
  platform API (Shopify `products.json` 250/page, WooCommerce `wc/v3` 100/page,
  BigCommerce storefront) returns a whole catalogue in **40–100 requests**
  instead of 10k page fetches (~300 MB → ~5 MB transfer). Sitemap + JSON-LD
  next; HTML crawl / Playwright only for stores whose `Store` profile requires
  it.
- **Incremental by default:** per-store crawl state (etag/lastmod) lives in
  MongoDB `Product.httpState` (✅ Phase B shipped — engine `resumeState` +
  `httpStateByUrl`, worker `loadResumeState`, persisted by the ingest
  pipeline), so **any worker — any machine — resumes where another stopped**;
  unchanged products skip via sitemap-lastmod **or a 304 conditional
  revalidation** (✅ shipped: the engine sends `If-None-Match` /
  `If-Modified-Since` from stored `httpState`; a `304` reuses the stored
  product instead of fetching + parsing the page — this also fixed a latent
  bug where null-lastmod stores were never refetched) and are counted in
  `skippedUnchanged`. SQLite stays as the checkpoint fallback + per-run
  scratch. Re-crawling an unchanged 10k-product store costs a handful of
  requests.
- **Two cadences per store:** a cheap **sitemap-only check** (1 request) to
  detect *new products* between deep crawls, and a daily/weekly **price
  re-crawl**. New products found by the shallow check are fetched
  individually — no full re-crawl needed to stay current.
  ✅ **Shallow mode is live** (`CrawlConfig.mode: 'shallow'` + `knownUrls`
  from the Product collection): the engine does sitemap-only discovery, skips
  platform/homepage/collection/API-probe/HTML-BFS work, and fetches ONLY new
  product pages via the HTML extractor (≈1 request + new pages; zero new = 1
  request). The scheduler's shallow cadence now uses it; `fullCrawl: false`
  keeps the removal diff safe.

#### 9.3 Comparing — indexed exact tiers + persisted matches

- **Exact tiers become index lookups.** Identity keys are stored + indexed at
  ingest; matching your catalogue against a competitor is a set of key
  lookups (O(n) total, not O(n·m)). The GTIN > SKU > slug priority is
  unchanged.
- **Fuzzy gets an inverted index.** Normalized names/tokens are indexed per
  store; candidates for a name must share a token, so only a handful of
  similarities are computed instead of the full cross product. **✅ Trigram
  tier shipped:** `Product.trigrams` (unique char trigrams of the padded
  normalized name, multikey `{origin, trigrams}` index) recovers the token
  tier's recall gap — near-duplicates sharing no tokens ("Nike Air" vs
  "NikeAri") surface via shared rare grams (frequency ≤ 200, capped, chunked
  `$in`), pre-filtered by shared ≥ 2 + trigram Jaccard ≥ 0.3, and accepted
  only when the best candidate's `nameSimilarity ≥ threshold`. It searches
  the full active competitor catalogue minus round-1 matched ids. This lets
  us retire the `FUZZY_PAIR_LIMIT` skip.
- **Matches are persisted, not recomputed.** `ProductMatch` is maintained
  incrementally: only products touched by a `ProductEvent` (new, changed name,
  price/stock change, removed) re-match, on a background task — never on the
  request path. **✅ No-op reconcile gate:** a finished crawl only re-runs
  `reconcileForOrigin` when its diff changed something (added/removed/price/
  stock/rename — `renamedCount` added to `crawlSync` so renames still
  re-match); an unchanged crawl skips matching entirely. **✅ ComparePanel is
  server-driven:** the Competitors page reads paginated `GET /api/match`
  (`onlyMine` added to the endpoint) instead of materialising two full
  catalogues in the browser — the client-side `compare.ts` is deleted.
- **Market analytics aggregate at ingest:** per-identity `MarketProduct` docs
  (which stores sell it, price range, min/max, store count) update when a
  crawl finishes, so pricing/dashboard queries are one indexed read.

#### 9.4 Change detection — identity diff at ingest

- Every finished crawl diffs its identity set against the previous snapshot's
  (hash-set diff, O(n log n) at ingest) → `added`, `removed`, `priceChanged`
  (old/new), `stockChanged`, written as `ProductEvent` rows and summarized on
  the `Snapshot`.
- The UI's "what's new since last crawl" diffs, per-product sparklines,
  biggest movers, and the future alert engine all **read `ProductEvent`** —
  nothing is recomputed on page load.

#### 9.5 Migration path (from today's `CrawlResult`)

**Phase 1 — DONE ✅** (models + dual-write + backfill shipped, live-Mongo
verified). **Phase 2 — DONE ✅** (worker pool + queue + scheduler shipped,
live-Mongo verified). **Phase 3 — DONE ✅** (indexed matching + persisted
`ProductMatch` shipped, live-Mongo verified). **Phase 4 — DONE ✅** (events
→ alerts shipped, live-Mongo verified). **Next: Phase 5 (productionize).**

- [x] **Backfill:** `backend/scripts/backfill.js` (`npm run backfill`)
      replays legacy `CrawlResult` docs into `Product` + `Snapshot` + events
      through the same `syncNewModel` pipeline the dual-write uses (identity
      keys via `backend/utils/identity.js`; `''` gtin/sku stripped to
      undefined; original `createdAt` timestamps preserved).
- [x] **Dual-read:** `saveCrawlResult` dual-writes legacy `CrawlResult` +
      the normalized model (`backend/services/crawlSync.js`) — reads still
      come from `CrawlResult` until the new read endpoints flip the UI (D1).
- [x] **Cooperative control + discovery speed:** `core/control.ts`
      (`CrawlControl` + `CrawlCancelledError`) checked between units of work
      (per product URL, per sitemap index child, per HTML-BFS page wave, per
      Woo/BC API walk page); worker polls `CrawlJob.control` (1.5s) and
      mirrors it into the engine handle. **Pause** holds the crawl (heartbeats
      keep running), **resume** clears it, **cancel** → `CrawlCancelledError`
      → job marked `cancelled`, nothing persisted (queued jobs cancel via the
      claim sweep; paused queued jobs are skipped by the claim filter). New
      `/crawler` page (list + pause/resume/cancel) + Sources panel controls +
      `GET /api/crawl-jobs/active` + `POST /api/crawl-jobs/:id/{pause,resume,
      cancel}`. Sitemap index children fetch in parallel (6 in flight) and the
      HTML BFS crawls in waves of 6 — discovery no longer serializes a
      23-child sitemap index for minutes. Verified: 11 live-Mongo E2E checks
      (claimed pause/resume/cancel + queued pause/cancel/resume).
      **Debug:** the engine counts every HTTP request (`HttpOptions.onRequest`,
      robots.txt + discovery + product fetches, retried attempts included) and
      reports it live (`CrawlConfig.onRequestCount` → `CrawlJob.progress.requests`);
      `publicJob` also exposes `workerId`. The Active crawls page shows worker
      id + request count per job. Verified: engine E2E (exactly 4 requests for
      a shallow 2-product run) + queue E2E (7 checks).
- [x] **Worker pool:** `CrawlJob` queue (claim/heartbeat/retry/timeout in
      `services/jobQueue.js`), standalone `backend/workers/worker.mjs`
      (runs the existing crawler engine via Node 24 type-stripping),
      `backend/workers/scheduler.mjs` (separate process, D4 — Store-cadence
      ticks with jitter + per-store min-interval guard), `services/saveCrawl.js`
      shared by the worker + controller, `POST/GET /api/crawl-jobs(/:id)` +
      schedules CRUD, and `src/lib/crawl.ts` rewired to the queue API (UI
      unchanged). Dev auto-spawn via `spawn.js` (`PARITY_INFRA=0` to disable;
      prod runs `npm run worker`/`npm run scheduler` per process manager).
      Verified live-Mongo: atomic claim, stale-release, retry→dead, job
      timeout, proxy scrubbing, worker E2E (deep → removal → shallow-safety →
      idempotent), scheduler no-double-fire + per-type anchors.
- [x] **Indexed matching:** `Product.tokens` (multikey inverted index, written
      at ingest) + `backend/services/matchService.js` — exact tiers (GTIN >
      SKU > slug) hit the sparse indexes via `$in`; fuzzy candidates come
      from `tokens: { $in: myTokens }` **plus a trigram tier**
      (`Product.trigrams` — rare-gram prefilter recovers the token tier's
      recall gap, gated by Jaccard ≥ 0.3 then `nameSimilarity` ≥ threshold);
      lazy token/trigram backfill for legacy docs (`ensureVocabForOrigin`);
      `reconcilePair` full-replace persists `ProductMatch` after every
      finished crawl (worker + controller share `saveFinishedCrawl`), **but a
      no-op crawl (nothing added/removed/price/stock/renamed) skips matching
      entirely**; `GET /api/match?origin=&page=&limit=` reads paginated
      matches + latest prices + `onlyTheirs`/`onlyMine` — no recomputation on
      page load, and the **Competitors ComparePanel is flipped onto it**
      (server-driven; client `compare.ts` deleted). Matcher emits `'fuzzy'`
      (ProductMatch enum aligned). One-off backfill:
      `backend/scripts/reconcile-matches.js` (`npm run reconcile-matches`).
      Verified live-Mongo: all four tiers + trigram recall gap, token-candidate
      fuzzy (incl. backfilled legacy docs), inactive exclusion, stale-row
      replacement, pagination + endpoint validation.
- [x] **Events → alerts:** `backend/services/alertsService.js` maps
      `ProductEvent` rows (computed once at ingest) to alerts — `added` →
      new_product (low), `removed` → removed (high), `price_changed` →
      price_drop/price_rise with signed % + amount and severity tiers (≥15%
      high, ≥5% medium), `stock_changed` → stock (restock low / out medium).
      `GET /api/data/alerts?type=&page=&limit=` (auth-protected) paginates
      the feed, excludes dismissed events, and reports `unreadCount` +
      `hasAnyEvents`; `POST /api/data/alerts/{read,read-all,dismiss}` persist
      per-user state in `AlertState` (unique userId+eventId, TTL 95d —
      outlives its event). Alerts page rebuilt: unread accent + click-to-read,
      dismiss, type filter, mark-all-read, server pagination, honest empty
      states. Verified: 9 unit tests + live-Mongo E2E (32 checks).
- [x] **Store read path (D1 freeze unlocked):** `backend/routes/stores.js` +
      `controllers/storeController.js` + `utils/readPath.js` (unit-tested
      helpers: keyset cursor, regex escape, key validation) —
      `GET /api/stores` (meta-only summaries; the worker-only
      `Store.scheduledCrawl.params.proxyUrl` is never exposed), `GET
      /api/stores/:key` (store profile + latest snapshot), `GET
      /api/stores/:key/products` (keyset-cursor pagination on `{key,
      lastSeenAt: -1}`, `q=` escaped name search, `$slice` sparkline
      projection — never full docs), `GET /api/stores/:key/snapshots`
      (metadata, `full: false` = shallow check), `GET /api/stores/:key/events`
      (`since=`/`type=` filters, keyset on `at`). Frontend: `api/stores.ts`
      clients + `stores` query keys (invalidated with crawl data), plus
      `DELETE /api/stores/:key` (cascade across the normalized collections +
      legacy `CrawlResult`). Verified: 8 unit tests + live-Mongo E2E (28
      checks). **`/stores/$origin` is flipped onto this read path** —
      server-paginated catalogue (debounced `q=` + keyset-cursor "Load more"
      accumulation with a search-generation token), snapshot-picker-driven
      stats/profile/discovery log, current-state price sparklines. Remaining
      per D1: flip `/crawls`, `/sources`, `/pricing`, then drop `CrawlResult`.

Order of work (each step keeps the app green: `tsc` → `lint` → `build`):
storage refactor → incremental crawl state → indexed matching →
events/alerts → store read path. *(Phases 1–4 shipped and the store read path
is live — `/stores/$origin` already reads it (D1 flip started); `/crawls`,
`/sources` and `/pricing` still read the legacy `CrawlResult` via dual-write
until they're flipped too, then `CrawlResult` is dropped.)*

**Resolved decisions (architecture.md §11 — Phase 1 can start):**
`CrawlResult` is dual-written through the migration, frozen when the new read
path goes live, then dropped one release later; `MarketProduct` ships in
Phase 1 (minimal aggregate, no text index yet); the new `Snapshot` history
caps at **10 per origin**; the scheduler is a **separate tiny process**
(`backend/workers/scheduler.js`), not a role inside a crawl worker.
