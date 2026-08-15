# Parity — Architecture (Scale: 100+ stores · 10k+ products per store)

> **Status:** Design document — **Phases 1 (storage refactor), 2 (worker
> pool + queue + scheduler), 3 (indexed matching) and 4 (events → alerts)
> are SHIPPED and live-Mongo verified**; the §9.5 migration checklist
> tracks what remains (Phase 5 productionize). Condensed plan lives in
> `plan.md` §9; this file is the working reference for anyone (human or
> agent) implementing it. It answers five questions with concrete schemas,
> indexes, flows, and capacity math:
>
> 1. How do we **save** ~1M products optimally?
> 2. How do we **fetch** them with the least compute?
> 3. How do we **compare** stores efficiently?
> 4. What happens when products are **added/removed**?
> 5. How do we get there from the code that exists today?

---

## 0. Scale targets & constraints

| Dimension          | Today                                        | Target                                   |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| Crawled websites   | a handful                                    | **100+**                           |
| Products per store | 0–2,000                                     | **1,000–50,000** (10k typical)    |
| Total product rows | ~10k                                         | **~1M**                            |
| Crawl cadence      | manual / in-memory schedules                 | scheduled shallow + deep, staggered      |
| Concurrent crawls  | 1 per SSR process                            | **N worker processes**, queued     |
| Snapshot history   | 20 full-product dumps/origin                 | metadata + events (products stored once) |
| Matching           | on-demand O(n·m) fuzzy, capped at 50k pairs | indexed, persisted, incremental          |

Hard constraints from the existing codebase:

- **Stack is TypeScript + Express + MongoDB, end to end.** The crawler
  (`backend/crawler/`) is already Node-only TS, battle-tested across
  8 build steps (tiered extraction, sitemap taxonomies, Woo/BigCommerce
  adapters, politeness, proxies, checkpointing). We do **not** rewrite it in
  Go; we extract it into worker processes (see §7 "Language decision").
- **MongoDB stays.** The storage refactor runs on the existing database
  (WiredTiger compresses well at this size). No database migration.
- Every step keeps the app green: `npx tsc --noEmit` → `npm run lint` →
  `npm run build` (frontend) and the backend booting + tests.

---

## 1. High-level architecture

```
                    ┌──────────────────────────────────────────────┐
                    │                Browser (TanStack UI)         │
                    │   /competitors  /stores/$origin  /alerts …   │
                    └──────────────────────┬───────────────────────┘
                                           │ REST / polling (TanStack Query)
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │           Express API  (:3000)               │
                    │  auth · dashboard · CRUD · read endpoints    │
                    │  enqueue crawl jobs · report job status      │
                    │  (reads ONLY projections/aggregations)       │
                    └───────────────┬──────────────────┬───────────┘
                                    │ enqueue job      │ read/write
                                    ▼                  ▼
                    ┌────────────────────────┐   ┌────────────────────────┐
                    │   CrawlJob queue (Mongo)│   │        MongoDB        │
                    │  status machine, claim, │   │  Store · Product ·    │
                    │  heartbeat, retries     │   │  Snapshot · Event ·   │
                    └───────────────┬─────────┘   │  Match · MarketProduct│
                                    │ claim       └────────────────────────┘
                                    ▼
        ┌───────────────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   Worker 1        Worker 2        Worker 3         …  (2–6 Node processes)
   ─────────────────────────────────────────────────────
   • claim job (atomic findOneAndUpdate)          • run crawl (reuses the
   • sitemap-only shallow check OR deep crawl       existing crawler engine)
   • post-crawl pipeline: normalize → bulk upsert → diff → events → match
   ─────────────────────────────────────────────────────
                                    │
                                    ▼
                        Target stores (HTTP, polite:
                        robots.txt, per-host concurrency,
                        adaptive throttle, optional proxy)
```

**Roles:**

- **Express** only orchestrates: auth, UI data reads, enqueue jobs, return job
  status. It never crawls and never runs the matcher synchronously.
- **Workers** do the heavy lifting. They are standalone Node processes that
  import the same crawler module today's `npm run crawl` CLI uses — a packaging
  change, not a rewrite.
- **MongoDB** is the single source of truth for jobs, products, history,
  events, and matches. SQLite checkpoints shrink to per-run scratch (see §3.4).

---

## 2. Storage — how we save ~1M products optimally

**Principle: store each product once; make history metadata + events, not
duplicated catalogues.** Today `CrawlResult` embeds the full product array in
every snapshot (10k products ≈ 5–10 MB/doc × 20 snapshots × 100 stores ≈
10–20 GB, and every read drags MBs over the wire). We replace it with six
collections. Heavy work happens at **ingest time**; reads are indexed lookups.

### 2.1 Collections

| Collection        | Purpose                                                                 | Approx. size at scale                                       |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Store`         | One doc per origin: profile, crawl config, cadence, last-run stats      | 100 × ~1 KB                                                |
| `Product`       | **Current state** — one doc per (origin, identity key)           | 1M × ~300 B ≈ 300–400 MB (compressed far less)           |
| `Snapshot`      | Crawl metadata + add/remove/change summary.**No product arrays.** | 100 × 10 × ~1 KB ≈ 1 MB                                  |
| `ProductEvent`  | Change log: added / removed / price / stock                             | ~10–20% of products/day ≈ 150–200k rows/day, TTL 90 days |
| `ProductMatch`  | Persisted your↔competitor pairs (method + confidence)                  | one row per matched pair per competitor                     |
| `MarketProduct` | Per-identity aggregate across stores (who sells it, price range)        | ≤#distinct identities (smaller than 1M)                    |

### 2.2 `Product` (the core collection)

```
{
  origin: "https://shop.example.com",        // full origin URL
  key: "shop.example.com",                   // normalized host (for grouping)
  identityKey: "gtin:0012345678905" | "sku:xyz-123" | "slug:blue-tshirt" | "url:<sha1>",
    // stable per-product key: first non-empty of gtin > sku > slug, else URL hash.
    // Used for BOTH change detection (same product over time) and matching.
  name: "Blue T-Shirt", brand: "Example", category: "Apparel",    price: 19.99, compareAtPrice: 24.99, currency: "AED", // null = unknown
    priceUsd: 5.44,  // converted at ingest (fxService) for cross-currency
    available: true, url: "https://…/blue-tshirt", image: "https://…",
  gtin: "0012345678905", sku: "xyz-123", slug: "blue-tshirt",   // raw, for tiers
  firstSeenAt: ISODate, lastSeenAt: ISODate, updatedAt: ISODate, priceUpdatedAt: ISODate,
  priceHistory: [ { t: ISODate, price: 19.99, available: true }, … ],  // capped ~90
  httpState: { etag: "…", lastmod: 1700000000 },   // incremental-fetch state (Phase B)
}
```

**Indexes:**

- `unique { origin: 1, identityKey: 1 }` — upsert key, dedupe guarantee.
- `sparse { gtin: 1 }`, `sparse { sku: 1 }`, `sparse { slug: 1 }` — match
  tiers become index lookups (§4).
- `{ origin: 1, lastSeenAt: -1 }` — "currently active" = `lastSeenAt >= lastCrawl`;
  soft-deleted products drop out of live views with a trivial query.
- `{ identityKey: 1, updatedAt: -1 }` — market aggregation + cross-store lookup.
- `{ key: 1, name: 1 }` — store search/sort.

**Why this scales:** 1M docs × ~300 B is a few hundred MB in Mongo, it grows
*linearly* with catalogue size (not × snapshots), and every page/API read uses
projections so the wire cost is proportional to what the user sees, not what
we store.

### 2.3 `Snapshot`, `ProductEvent`, `ProductMatch`, `MarketProduct`

`Snapshot` (history, one per crawl):

```
{ origin, key, startedAt, finishedAt, durationMs,
  stats: { discovered, fetched, skippedUnchanged, failed },
  productCount, addedCount, removedCount, priceChangedCount, stockChangedCount,
  addedKeys: [identityKey…], removedKeys: [identityKey…],   // capped (e.g. 500)
  discovery: { … }, failures: [ … capped 100 ] }            // reuse existing shapes
```

Index: `{ origin: 1, finishedAt: -1 }`.

`ProductEvent` (the change log that powers "what's new", sparklines, alerts):

```
{ origin, key, type: "added"|"removed"|"price_changed"|"stock_changed",
  productId, identityKey, name, url,            // denormalized so reads need no join
  old: { price, available }, new: { price, available },
  snapshotId, at }
```

Indexes: `{ origin: 1, at: -1 }`, `{ type: 1, at: -1 }`, `{ productId: 1, at: -1 }`.
TTL on `at` (~90 days; roll up older events into daily aggregates if needed).

`ProductMatch` (persisted comparison):

```
{ mineProductId, mineOrigin, competitorKey, competitorProductId,
  method: "GTIN"|"SKU"|"URL slug"|"fuzzy", confidence, updatedAt }
```

Indexes: `unique { mineProductId: 1, competitorKey: 1 }`, `{ competitorKey: 1, method: 1 }`.

`MarketProduct` (aggregate at ingest, optional but cheap):

```
{ identityKey, name, brand, storeCount, minPrice, maxPrice, avgPrice,
  stores: [ { key, price, available, updatedAt } ], updatedAt }
```

Index: `unique { identityKey: 1 }` + text index on `name` for market search.

### 2.4 Snapshot history vs. the old `CrawlResult`

| Concern                                 | Old model                                   | New model                                                                                       |
| --------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "What did store X look like on date D?" | full product dump per date                  | `Snapshot` + products with `priceHistory` (point-in-time price via `{t ≤ D}` last point) |
| "What changed since last crawl?"        | recompute by diffing two big arrays on read | **computed once at ingest**, stored as `ProductEvent`                                   |
| "Price trend for product P?"            | scan snapshot docs                          | capped`priceHistory` array on the product doc                                                 |
| "Is product P still sold?"              | check latest snapshot                       | `lastSeenAt >= lastCrawl` index query                                                         |

---

## 3. Fetching — least compute

### 3.1 Rule #1: never fetch what we already have

- **Sitemap-lastmod gate:** if the sitemap's `lastmod` is unchanged since the
  previous deep crawl and no force flag is set, skip the whole product fetch
  (cost: ~1 request). Everything counts as `skippedUnchanged`.
- **Per-product etag/lastmod** (already implemented in the crawler's SQLite
  checkpoints): unchanged products are not re-downloaded. ✅ **Phase B
  shipped** — this state now lives in `Product.httpState` (etag + lastmod),
  loaded into a `resumeState` map by any worker at job start; the engine
  skips URLs whose sitemap lastmod is unchanged and reuses the stored
  product (ingest still sees the full catalogue), and persists the run's
  etag/lastmod back through `httpStateByUrl` → the ingest pipeline. *Any*
  worker — any machine — resumes where another stopped. SQLite remains as
  the checkpoint fallback + per-run scratch. Etag is captured/persisted but
  not yet a skip signal (lastmod-less sitemaps refetch every run).
- **API-first extraction (already built — make it the default per store):**
  a public platform API returns a whole catalogue in a handful of requests:

  | Source                                            | Requests for 10k products | Transfer          |
  | ------------------------------------------------- | ------------------------- | ----------------- |
  | Shopify`products.json` (250/page)               | 40                        | ~5 MB             |
  | WooCommerce`/wp-json/wc/v3/products` (100/page) | 100                       | ~5–10 MB         |
  | BigCommerce storefront (250/page)                 | 40                        | ~5 MB             |
  | Sitemap + JSON-LD page crawl                      | 10,000                    | ~300 MB           |
  | HTML heuristics / Playwright                      | 10,000+                   | ~300 MB+ and slow |

  The `Store.platform` profile decides the tier; HTML/Playwright run only for
  stores that need them.

### 3.2 Two cadences per store

| Check                             | Frequency              | Cost                                        | Catches                      |
| --------------------------------- | ---------------------- | ------------------------------------------- | ---------------------------- |
| **Shallow** (sitemap-only)  | 1–24 h                | 1 request + fetch only*new* product pages | New/removed products         |
| **Deep** (full price crawl) | 6 h – 7 d (per store) | full run, incremental                       | Price/stock changes, renames |

New URLs found by a shallow check are fetched immediately (only those pages),
so the catalogue stays current without re-crawling everything.

**2026-08 hardening:**

- **Product-URL pattern filter** (`CrawlConfig.productUrlPattern`) — an
  optional per-crawl regex applied to every discovered URL. For stores whose
  sitemap mixes real products with blog/brand/category pages under the SAME
  path tree (the leaf heuristic can't tell them apart), it keeps only
  matching URLs (activefitnessstore: `/\d{4,}$/` keeps EAN/SKU-terminated
  product URLs, cutting 10,456 → ~500). Invalid regex → warning finding, crawl
  proceeds unfiltered.
- **Auto browser-rendering re-crawl** — a deep crawl that ran with rendering
  OFF, fetched ≥ 10 pages and extracted zero prices auto-enqueues one re-run
  with `useBrowser: true` (plus a finding on the result). Guarded against
  loops (the follow-up itself runs with rendering ON).
- **Cross-currency via `priceUsd`** — the mapper carries the extracted
  `priceCurrency` through to ingestion; `Product.currency` defaults to `null`
  (unknown) instead of a silent "USD"; `fxService` fetches daily USD-base
  rates (no key, cached in Mongo) and the ingest pipeline stores
  `Product.priceUsd`. Matcher price gaps compare USD first, native only when
  both sides share a currency.

### 3.3 Job queue & workers (the "multiple users crawling at once" problem)

`CrawlJob` collection — a DB-backed queue, **no Redis needed at this scale**:

```
{ _id, storeKey, origin, type: "shallow"|"deep", status: "queued"|"claimed"|"done"|"failed"|"retrying",
  attempts, maxAttempts, scheduledAt, startedAt, finishedAt, workerId, heartbeatAt,
  params: { …crawl config snapshot }, progress: { discovered, fetched, total, … }, error }
```

Index: `{ status: 1, scheduledAt: 1 }`.

- **Enqueue:** Express (or the scheduler process) inserts jobs. A scheduler
  (cron inside one worker, or a tiny separate process) enqueues shallow + deep
  jobs per store with **jitter and a per-store min-interval** so 100 stores
  never fire at once.
- **Claim:** worker atomically claims via
  `findOneAndUpdate({status:"queued"}, {$set:{status:"claimed",workerId,heartbeatAt:now}})`.
  Heartbeats every ~30 s; a `heartbeatAt` older than X releases the job
  (crash-safe resume).
- **Retries:** exponential backoff on failures, `maxAttempts` cap, dead-letter
  status for triage.
- **Throughput:** one worker deep-crawls a 10k-product store in roughly
  10–40 min at polite speeds (2–8 concurrent/host). 100 stores weekly deep +
  daily shallow ≈ a few workers. Add workers without touching Express.
- **Live progress UI:** workers update `CrawlJob.progress`; the Sources page
  polls it (replacing today's in-memory `CrawlJob` server functions with a
  `GET /api/crawl-jobs/:id` read of the same counters — UI unchanged).
- **Worker memory is bounded (2026-08).** A 20–25 min deep crawl churns GBs of
  HTML through V8, which grows to its high-water mark and never returns memory
  to the OS — 3 workers × 6 concurrent requests drove the dev machine to 97%
  RAM and swapping. Workers now spawn with `--expose-gc --max-old-space-size`
  (`PARITY_WORKER_MAX_OLD_SPACE_MB`, default 3072, in `.env`) and force a GC
  every 1000 products + after each job, so RSS comes back down instead of
  ratcheting up. `npm run worker` carries the same flags.

### 3.4 Where SQLite goes

Today's per-origin SQLite checkpoint (`core/checkpoint.ts`) stays as the
**per-run scratch store** (crash-safe incremental saves *during* a run) in
single-worker setups, and `Product.httpState` in Mongo becomes the durable
cross-worker resume state in Phase B. Never store final data in SQLite — Mongo
is the source of truth.

### 3.5 Politeness budget (the real scaling constraint)

More workers ≠ more parallelism per host. The network bottleneck for crawling
is **target-site rate limiting and bans**, not our CPUs. Per-host concurrency
(2–8), robots.txt + crawl-delay, adaptive 429 backoff, and optional residential
proxies are already built and stay unchanged. Scaling means *more hosts in
parallel* (a worker pool), not hammering one host harder.

---

## 4. Comparing — efficient matching

### 4.1 Exact tiers become index lookups

Today `matchCatalogues` builds in-memory Maps and is O(n·m) worst-case for the
fuzzy pass (already capped at 50k pairs). With `Product` indexed on
`gtin`/`sku`/`slug`, matching your catalogue against a competitor is:

1. Query competitor products by your `gtin`s → `$in` on the sparse index.
2. Unmatched leftovers by `sku` → same.
3. Unmatched leftovers by `slug` → same.

Each step is O(your products × ~1), so 10k × 10k exact matching is seconds of
indexed reads — **never minutes of synchronous CPU**.

### 4.2 Fuzzy gets an inverted token index

For the residual unmatched set:

- Store each competitor product's normalized name tokens in a
  `token → [productId]` map (built once per store at ingest — or a dedicated
  `ProductToken` collection).
- Candidates for your product = union of its token buckets.
- Score **only the candidates** with the existing `nameSimilarity`; the full
  cross product is never enumerated. This retires `FUZZY_PAIR_LIMIT`.

### 4.3 Matches are persisted and updated incrementally

- `ProductMatch` rows are written by a background **match worker** fed by a
  small queue (or processed in the post-crawl pipeline).
- Only products touched by a `ProductEvent` (added / renamed / price or stock
  changed / removed) re-match — an unchanged catalogue costs nothing.
- Read path: `GET /api/match/:competitor` returns paginated `ProductMatch`
  joined with the latest prices. **No recomputation on page load**, and the
  client-side `compareStoresAsync` remains only as a fallback for tiny sets.
- One match per (your product, competitor store): a product sold by 5
  competitors appears in 5 `ProductMatch` rows.
- **Cross-currency (2026-08):** price gaps are computed in `priceUsd` when
  both sides have it (rates normalized at ingest); native prices are used only
  when both stores share a currency, and cross-currency rows without a
  conversion read as "different currencies" — raw AED vs PKR numbers are
  never compared as if equal. `MarketProduct` aggregates should be computed
  in the same USD basis.

### 4.4 Market analytics aggregate at ingest

When a crawl finishes, `MarketProduct` docs update: which stores sell identity
K, min/max/avg price, store count. Pricing-page trends and "cheapest
competitor" become **one indexed read** instead of a live join over 1M
products.

---

## 5. Change detection — added/removed products

### 5.1 Identity diff at ingest (O(n log n), happens once per crawl)

When a crawl finishes, the post-crawl pipeline runs in this order:

1. **Upsert** products (bulk, `ordered: false`) — sets `lastSeenAt = now` for
   everything seen.
2. **Added** = identityKeys in this crawl not in the previous snapshot's set.
   New `Product` docs; write `added` events.
3. **Removed** = previous snapshot's keys not in this crawl. **Soft delete**:
   leave the `Product` doc (history + sparklines stay), `lastSeenAt` keeps its
   old value, and the active-set index query (`lastSeenAt >= lastCrawl`)
   instantly excludes it from live views. Write `removed` events.
4. **Changed** = seen products whose `price`/`available`/`name` differ from the
   stored doc. Append to `priceHistory` (capped ~90), write
   `price_changed`/`stock_changed` events, update `priceUpdatedAt`.
5. Write the `Snapshot` summary (counts + capped added/removed keys) and
   update `MarketProduct` aggregates.

### 5.2 Everything downstream reads events

- "What's new since the last crawl" diff → `ProductEvent` rows for that origin
  since last snapshot.
- Per-product sparklines → `priceHistory` + `ProductEvent`.
- "Biggest movers" → `price_changed` events ordered by %.
- ✅ The `/alerts` engine **shipped (Phase 4)** — it subscribes to
  `ProductEvent` (price drops/rises with signed % + amount, new products,
  removals, stock changes) via `backend/services/alertsService.js`;
  `GET /api/data/alerts?type=&page=&limit=` (auth-protected) is a paginated
  indexed read with per-user read/dismiss state in `AlertState`. **Zero
  recomputation on read** — this is what makes alerts feasible at 1M products.

### 5.3 Correctness notes

- Identity quality matters: stores that never emit gtin/sku fall back to slug
  or URL-hash, so per-store stability is preserved (URLs rarely change).
  Cross-store matching for those products relies on the fuzzy tier.
- Renames: a name change without a URL/key change is a `changed` event, not
  remove+add. A URL change *with* the same gtin/sku keeps the same
  `identityKey` (gtin/sku win) — identity survives re-slugging.
- Concurrency: one crawl per origin at a time (enforced by the queue's
  per-store min-interval), so diffs never race.

---

## 6. Read path (how the UI stays fast)

| Endpoint                                  | Backing                                                      | Notes                              |
| ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| ✅ `GET /api/stores`                   | `Store` (productCount kept at ingest)                     | meta only, `proxyUrl` never exposed |
| ✅ `GET /api/stores/:key/products`     | `Product` projection, keyset-cursor-paginated, `q=` search | never full docs, `$slice` sparkline |
| ✅ `GET /api/stores/:key/snapshots`    | `Snapshot` meta (`full` flag = shallow)                   | replaces heavy`CrawlResult` list |
| ✅ `GET /api/stores/:key/events?since=`| `ProductEvent` (`since=`/`type=`)                          | "what's new", keyset on `at`        |
| ✅ `GET /api/stores/:key`              | `Store` + latest `Snapshot`                                | profile read                        |
| ✅ `GET /api/match/:competitor`        | `ProductMatch` + latest prices                             | paginated, no recompute            |
| ⬜ `GET /api/market/products`          | `MarketProduct`                                            | one indexed read                   |
| ✅ `GET /api/crawl-jobs/:id`           | `CrawlJob.progress`                                        | replaces in-memory poll            |

- ✅ The store read-path endpoints shipped with Phase 5 (D1):
  `backend/routes/stores.js` + `controllers/storeController.js` +
  `utils/readPath.js` (unit-tested keyset cursors), mounted at `/api/stores`;
  frontend clients in `api/stores.ts`. `GET /api/market/products` is NOT
  exposed yet — `MarketProduct` aggregates aren't written at ingest, so it
  would return empty data; build the aggregate first, then add the read.
- The existing `?meta=1` crawl-results summaries already proved the pattern:
  product-count-only responses (~10 KB instead of 10 MB). They now also carry
  `type`/`collections`/`discovery` (sitemap candidate URL lists stripped —
  they were the catalogue again) plus a `?limit=` param; the Sources page runs
  entirely on these + one targeted prev-snapshot fetch instead of polling full
  product arrays every 30s.
- TanStack Query `staleTime` per endpoint; `MATCHER_STALE_TIME` for
  matcher-backed endpoints (already in `src/api/`).
- List endpoints use cursor pagination; aggregations are precomputed at ingest
  (§4.4) rather than run on request.

---

## 7. Technology decisions & rationale

| Decision           | Choice                                     | Why                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crawler language   | **TypeScript (unchanged)**           | The engine, adapters, and parsers are already built and verified; a Go port re-does 8 steps of parsing work (`colly`/`goquery` don't help with JSON-LD, our primary extraction path)              |
| Crawler runtime    | **Standalone Node worker processes** | Crawling is I/O-bound; politeness caps per-host concurrency at 2–8, so Node's event loop is not the bottleneck. The existing module is already isolated — extracting it is packaging, not a rewrite |
| Job queue          | **MongoDB `CrawlJob` collection**  | Zero new infra at this scale; atomic claim + heartbeat + retry is ~200 LOC. Upgrade to Redis/BullMQ or NATS only if queue throughput ever becomes the bottleneck                                      |
| Database           | **MongoDB (unchanged)**              | Already in use; WiredTiger compression handles ~1M small docs comfortably. Postgres gains nothing here                                                                                                |
| Go worker fleet    | **Only if metrics demand**           | Threshold: tens of millions of pages/day or a multi-tenant scraping platform. The queue boundary is exactly where a Go fleet would slot in later without touching Express                             |
| Browser automation | Playwright (unchanged)                     | Chromium memory cost is identical across languages; it's a fallback tier, not the default path                                                                                                        |
| Proxies            | opt-in residential gateway (unchanged)     | Provider-side IP rotation for reputation-blocked stores; never persisted                                                                                                                              |

---

## 8. Capacity math (sanity check)

- **Storage:** 1M `Product` docs × ~300 B ≈ 300–400 MB raw, well under
  WiredTiger-compressed footprint. Snapshots ≈ 2 MB. Events ≈ 200k rows/day ≈
  3–5 GB over 90-day TTL — acceptable; roll up to daily aggregates if it
  grows. **Single replica set is fine to ~5–10M products; shard on `origin`
  beyond that.**
- **Network:** deep crawl of a 10k-product store ≈ 40–100 requests via
  platform API (~5 MB) vs 10k requests (~300 MB) via page crawl. 100 stores
  weekly deep + daily shallow ≈ **a few thousand requests/day**, well within
  one worker pool.
- **CPU:** post-crawl processing (normalize, upsert, diff) is a few seconds of
  work per 10k products. Matching is incremental (§4.3). Nothing heavy runs on
  the request path.
- **Workers:** 2–6 processes cover 100 stores at daily/weekly cadence with
  headroom. Scale = add workers; nothing else changes.

---

## 9. Migration path from today's code

**Phase 1 — Storage refactor (biggest win, do first)** — §11 decisions D1–D3
apply (dual-write `CrawlResult`, `MarketProduct` in scope, `Snapshot` cap 10).

1. New models: `Store`, `Product`, `Snapshot`, `ProductEvent`,
   `ProductMatch`, `MarketProduct` + indexes (backend `models/`).
2. Backfill script: split existing `CrawlResult` docs → `Product` (current
   state from newest snapshot) + `Snapshot` (metadata) + `ProductEvent`
   (diff between consecutive snapshots). Identity keys already exist on
   products.
3. Dual-write: `saveCrawlResult` also upserts `Product`/`Snapshot`/events.
4. Flip read endpoints to projections (`?meta=1` already done; add the
   `Product` list endpoints). Keep `CrawlResult` reads working meanwhile.

**Phase 2 — Workers & incremental fetch**
5. Extract the crawler into a standalone worker entry (reuse
   `src/lib/crawler/` verbatim); add `CrawlJob` collection + claim/heartbeat;
   scheduler enqueues shallow + deep jobs with per-store intervals.
6. Replace in-memory `startCrawl`/`getCrawlSchedules` server functions with
   job enqueue + `GET /api/crawl-jobs/:id` polling (Sources UI unchanged in
   behavior).
7. ✅ Move resume state to `Product.httpState` (Phase B of §3.1) — shipped
   with the shallow-mode work (engine `resumeState` + `httpStateByUrl`,
   worker `loadResumeState`, pipeline persistence).

**Phase 3 — Indexed matching** ✅ shipped (backend `services/matchService.js`,
`models/Product.js` `tokens` field + `{origin, tokens}` multikey index,
`controllers/matchController.js` + `routes/match.js`, `scripts/reconcile-matches.js`)
8. Match via index lookups + token inverted index; persist `ProductMatch`;
   wire `GET /api/match?origin=&page=&limit=`; keep `compareStoresAsync` as
   fallback only.

**Phase 3 implemented deviations (deliberate, recorded here):**

1. **Fuzzy candidates require a shared token.** The inverted index returns
   docs sharing ≥1 token with your product; pairs sharing *no* token (e.g.
   "Nike Air" vs "NikeAri", plural/stem variants) are invisible to the fuzzy
   tier even though Levenshtein would score them ≥ 0.8. This is the accepted
   §10 "fuzzy recall" trade-off of an inverted index at 10k×10k scale; a
   stemmed/character-ngram index is future work. Exact tiers (GTIN/SKU/slug)
   are unaffected.
2. **Reconcile scope.** `saveFinishedCrawl` re-matches everything a crawl
   touched: your-store crawl → re-match vs **every** competitor; a competitor
   crawl → re-match just that pair. Pairs are reconciled sequentially per
   run, with a full deleteMany→insertMany replace (idempotent; the
   `(mineProductId, competitorKey)` unique index guards rows). A my-store
   origin switch is handled by scoping every read/count to `mineOrigin`.
   All counts/reads scope by `mineOrigin` — stale rows from a previous
   store never leak into totals.

**Phase 4 — Events → product features** ✅ shipped
9. `ProductEvent` now drives the `/alerts` engine: `services/alertsService.js`
   maps event rows to alerts (`added`→new_product, `removed`→removed,
   `price_changed`→price_drop/price_rise with signed % + amount + severity
   tiers ≥15% high / ≥5% medium, `stock_changed`→stock), the Alerts page
   renders the feed (type filter, server pagination, unread accent,
   click-to-read, dismiss, mark-all-read, honest empty states), and per-user
   read/dismiss state lives in `AlertState` (unique `{userId, eventId}`, TTL
   95d — outlives its event so `unreadCount = totalEvents − seen` stays
   consistent). "What's new" diffs, sparklines and biggest movers already
   read `ProductEvent` rows from the ingest pipeline.

**Phase 5 — Productionize**
10. Auth on `/api/data/*`, observability (job metrics, crawl logs), deploy
    workers as separate containers, CI.

Each phase keeps the app green and is shippable independently; the UI is
preserved because the read endpoints keep their shapes.

---

## 10. Risks & trade-offs

- **Write amplification at ingest:** bulk upserts of 10k products per crawl are
  fine in Mongo but must be batched (`bulkWrite`, `ordered: false`, ~5k/batch)
  and run off the request path (in the worker).
- **Identity collisions:** two products sharing a slug in one store → the
  unique `{origin, identityKey}` index forces first-wins; review fallback to
  URL-hash when slugs are known-generic (`/p`, `/dp`).
- **Fuzzy recall:** the inverted index is a candidate filter; near-duplicate
  names sharing no tokens are missed. Keep the threshold tunable and monitor
  unmatched rates per store.
- **Sitemap-less / bot-protected stores:** stay on the expensive tiers; budget
  the first 100 stores toward API/sitemap-friendly targets, and use proxies +
  Playwright only where required. **UA lesson (2026-08):** a browser-like
  Chrome UA got HTTP 200s on stores that 429'd `ParityBot/1.0` on every request
  (curl-verified); the change was fully implemented and then **reverted by
  decision** — ParityBot stays, so 429-blocked stores (prosportsae, athletix)
  rely on the Tier 2 proxy + slowed concurrency, and blocked runs stack empty
  snapshots worth clearing.
- **Long snapshot history:** products keep a capped `priceHistory` (~90
  points); anything older is only recoverable from `ProductEvent` (TTL 90
  days) — if long-range trends are a product requirement, add a daily rollup
  collection.
- **Queue correctness:** claim must be atomic and heartbeats must expire
  stale claims; a misbehaving worker must not hold a store's job forever (job
  timeout + release).

---

## 11. Decisions (resolved — Phase 1 can start clean)

These four questions are settled. Each entry records the decision, why, and
its concrete consequence for the code.

### D1 — `CrawlResult`: dual-write, freeze, then drop

**Decision:** keep `CrawlResult` working through the migration as a compat
layer, but never as a permanent store:

- **Phase 1–2 — dual-write.** The new pipeline also writes the legacy
  `CrawlResult` doc (reusing today's `saveCrawlResult` shape), so every page
  that reads `useSavedCrawls` today (`/stores/$origin`, `/crawls`,
  `/sources`, `/pricing`) keeps working unchanged while the new read
  endpoints land.
- **Phase 3 — freeze.** When the new read path (`/api/stores/:origin/products`,
  snapshots, events) goes live and the UI flips to it, stop writing
  `CrawlResult`. No new docs; the collection is frozen. ✅ **The read path
  endpoints are built and live-Mongo verified (Phase 5, `routes/stores.js` +
  `storeController.js`)** and **`/stores/$origin` is flipped onto them**
  (D1 read path: server-paginated catalogue with debounced `q=` + keyset
  cursors, snapshot-picker-driven stats/profile/log, cascade `DELETE
  /api/stores/:key`) — the remaining freeze step is flipping `/crawls`,
  `/sources`, `/pricing` onto the same endpoints.
- **Phase 5 — drop.** After one full release on the new read path, `drop()`
  the collection in a migration script. The backfill already reproduced
  everything in `Product` / `Snapshot` / `ProductEvent`, so nothing is lost —
  and keeping MB-sized product arrays per snapshot doc is precisely the
  10–20 GB problem this design exists to solve.

Why not keep it forever: it *is* the old storage model. Why not drop it at
Phase 3: the fallback window de-risks the UI migration, and `?meta=1`
summaries keep the reads cheap during it.

### D2 — `MarketProduct`: build it now, minimal scope

**Decision:** build `MarketProduct` in Phase 1 as part of the post-crawl
pipeline, not deferred. Rationale:

- It is ~1 day of work *inside a pipeline we are writing anyway*; deferring
  means editing the ingest code a second time.
- It does not depend on matching being complete: identity keys are
  cross-store by construction for the exact tiers (a GTIN is global), so the
  aggregate is correct from the first backfilled store pair.
- It immediately unblocks fast market pricing on `/pricing` and the dashboard
  (one indexed read instead of a live join over products).

Scope it down to the essential aggregate now: `identityKey, name, brand,
storeCount, minPrice, maxPrice, avgPrice, stores[{key, price, available,
updatedAt}]` + unique index on `identityKey`. Defer the text index and market
search until the Catalogue page needs them.

### D3 — Snapshot depth: trim to 10 per origin

**Decision:** the new `Snapshot` collection keeps **10 per origin** (legacy
`CrawlResult` keeps its existing cap of 20 only while it is dual-written).

- `priceHistory` (capped ~90 points on each `Product`) already carries the
  price time series and `ProductEvent` (TTL 90 days) carries the change log —
  snapshots are metadata only (~1 KB), so the cap is about diff/backfill
  steps and picker granularity, not storage.
- Fewer snapshots = fewer backfill diff steps (20 → 10 per origin) and a
  smaller `addedKeys` / `removedKeys` history.
- One `Snapshot` is written per **completed crawl run** (shallow or deep —
  each produces an identity diff), so 10 snapshots ≈ 10 runs of history for
  the UI's snapshot picker. The time series itself is untouched by this cap.
- Enforce with a `SNAPSHOT_LIMIT = 10` constant and the same
  keep-newest-N-then-delete pattern `crawlController.js` uses today.

### D4 — Scheduler: separate tiny process, not inside a worker

**Decision:** the scheduler is a **standalone process**
(`backend/workers/scheduler.mjs` — shipped; the crawl worker is
`backend/workers/worker.mjs`, both ESM that import the frontend TS crawler
via Node 24 native type-stripping), not a role inside a crawl worker. Rationale:

- Today's scheduler is an in-memory `setInterval` in the SSR process
  (`frontend/src/lib/crawl.ts`) that resets on restart and would multiply
  itself if the SSR layer ever runs N instances. Phase 2's whole point is
  that crawling survives API restarts.
- A scheduler inside one worker dies when that worker is busy or restarts —
  and the pool has no leader election.
- A standalone scheduler is ~50 LOC and crash-safe by construction: it reads
  `Store` cadence config + last-run times from Mongo and enqueues `CrawlJob`s
  with jitter and a per-store min-interval. Enqueue is guarded by "no
  queued/claimed/active job for this store+type within the min-interval", so
  even two racing scheduler instances cannot double-fire. If the scheduler is
  down, missed ticks merely delay the next enqueue — nothing is lost.

Deployment: one worker image, two entry points — `worker.mjs` (crawl pool,
N instances) and `scheduler.mjs` (single instance). In dev, `backend/index.js`
auto-spawns them (`PARITY_INFRA=0` disables; `PARITY_WORKERS`/`PARITY_SCHEDULER`
tune counts); production runs them under its own process manager.

**Phase 2 implemented deviations (deliberate, recorded here):**

1. **Proxy URL now rests in the DB** (`CrawlJob.params.proxyUrl` +
   `Store.scheduledCrawl.params.proxyUrl`) — a cross-process worker needs the
   gateway URL at crawl time and there is no shared server memory. It is
   **stripped from every API response** (`publicJob`/`publicSchedule` expose
   only the boolean) and never written to crawl results/logs. §3.2's
   "server-memory only" rule now means "Mongo, never returned to clients".
2. **Cadence derivation:** UI schedules store `frequency` on the Store record;
   the scheduler derives shallow/deep hours from it (shallow at the
   frequency, deep floored at 6h — the `cadenceSchema` min). Stores are only
   auto-scheduled when `cadence.enabled` is set (default **false** — merely
   being crawled never schedules a store). Per-type anchors
   `lastShallowAt`/`lastDeepAt` keep the two cadences independent.
3. **`shallow` jobs were not cheap — now FIXED (Phase 3.5).** The engine has
   a real sitemap-only mode: `CrawlConfig.mode: 'shallow'` + `knownUrls`.
   `discoverProducts` skips platform detection, homepage analysis, collection
   walks, API probes and the HTML BFS; keeps only sitemap product URLs not
   already in `knownUrls` (loaded by the worker from `Product.select('url')`);
   and the fetch loop uses the HTML extractor only (no API-first adapters, no
   Shopify JSON probes). Cost ≈ 1 request + new product pages; zero new
   products = exactly 1 request. `fullCrawl: false` still guards the ingest
   removal diff. A missing/errored sitemap reports a warning ("no sitemap
   product URLs"), not a false "no new products" success.
