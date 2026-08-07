# Parity — Project Summary

A condensed status snapshot: where the plan stands, the bug fixed this session,
and how the architecture changed from "before" to "now".

---

## 🐛 Bug fixed this session — worker crash-loop on boot

**Symptom** (from `npm run dev` in `backend/`):

```
[crawl-infra] spawned 1 worker(s) + scheduler
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'C:\Users\PC-24\Desktop\competitorAnalysis\backend\frontend\src\lib\crawler\index.ts'
  imported from C:\Users\PC-24\Desktop\competitorAnalysis\backend\workers\worker.mjs
[crawl-infra] worker 1 exited (code=1 signal=null) — respawning in 3s
```

**Root cause:** the worker resolves the crawler module **relative to its own
file** (`backend/workers/worker.mjs`). `'../frontend/src/lib/crawler/index.ts'`
therefore landed in `backend/frontend/…` (one level too shallow) instead of the
sibling `frontend/` package at the project root. The error message shows the
wrong path exactly.

**Fix:** `backend/workers/worker.mjs` now loads
`'../../frontend/src/lib/crawler/index.ts'` (with a comment explaining why it's
two levels up, so it never regresses).

**Verified:**
- The module resolves to `competitorAnalysis\frontend\src\lib\crawler\index.ts`
  and `runCrawl` loads as a function.
- A live worker boot against a throwaway Mongo prints
  `worker online — claiming crawl jobs from Mongo` with no module error.
- Backend jest still 21/21.

> Just restart `npm run dev` — the respawn loop is gone.

---

## ⚡ Optimization batch this session

Five efficiency wins shipped (all five from the improvement menu), verified
with live-Mongo E2Es:

1. **No-op reconciles are skipped.** A finished crawl only re-runs matching
   when its diff changed something (added/removed/price/stock/rename —
   `renamedCount` added so renames still re-match). Unchanged stores now cost
   zero matcher CPU instead of a full re-match every run.
2. **Backfill ran against the live `crawler` DB** — 18,434 products, 18
   snapshots and 21,767 events written from the 20 legacy `CrawlResult` docs
   (dry-run first). `products` went from 1 doc to ~18k; the normalized model
   is now the real data source (the legacy collection can be dropped in
   Phase 5).
3. **Etag skip in the engine.** The crawler sends `If-None-Match` /
   `If-Modified-Since` from stored `Product.httpState`; a `304` reuses the
   stored product instead of fetching + parsing the page. This also fixed a
   latent bug: stores whose sitemap has no `lastmod` were *never* refetched
   (null === null skipped them) — they now revalidate conditionally.
4. **Trigram fuzzy tier.** `Product.trigrams` (multikey index) recovers
   near-duplicates the token index misses ("Nike Air" vs "NikeAri") via
   shared rare grams + a Jaccard pre-filter, with the `nameSimilarity`
   acceptance gate. Verified by a live-Mongo E2E reproducing the recall gap.
5. **ComparePanel is server-driven.** The Competitors page reads paginated
   `GET /api/match` (with `onlyMine`) instead of materialising two full
   catalogues in the browser; the dead client-side `compare.ts` is deleted.

Everything validated: backend jest (30/30), frontend tsc/eslint/build clean,
plus live-Mongo E2Es for the trigram tier, the no-op gate and the etag 304
flow.

---

## 🔧 Latest session — crawl performance, memory & the DB (Aug 2026)

### Worker memory fix (the 97% RAM / lag)
- A deep crawl runs 20–25 min fetching + parsing 100 KB–2 MB pages; V8's heap
  grows to its high-water mark and **never returns memory to the OS** — 3
  workers × 6 concurrent requests pushed the machine to 97% RAM and swapping
  (Task Manager showed one Node process at 6.5 GB).
- Fix: workers spawn with `--expose-gc --max-old-space-size` (knob
  `PARITY_WORKER_MAX_OLD_SPACE_MB` in `.env`, default 3072) and force a full GC
  **every 1000 products** and **after every job**. `npm run worker` and
  `.env.example` carry the same flags. ⚠️ Restart the backend to apply — only
  newly spawned workers get the cap.

### Sources page stopped downloading catalogues
- The page you watch while crawling polled the *full* crawl-results endpoint
  (every store's complete product arrays) every 30 s. It now polls lightweight
  `?meta=1` summaries — the backend projection gained
  `type`/`collections`/`discovery` with the sitemap candidates' **URL lists
  stripped** (they were the catalogue again), plus a `?limit=` param for the
  one targeted prev-snapshot fetch when a crawl finishes. `/crawls` +
  `/pricing` still poll full catalogues — migrate them next if they lag.

### UA experiment → reverted (decision recorded)
- A browser-like Chrome UA got HTTP 200s where `ParityBot/1.0` got 429s on
  prosportsae.com / athletix.ae (curl-verified). It was implemented end-to-end
  (engine → queue → schedule → UI field) and then **fully reverted by
  decision** — ParityBot stays, and blocked stores rely on the Tier 2
  residential proxy + slower concurrency instead. Don't re-do this without a
  fresh decision.

### Live DB state (crawler-new, Aug 2026)

| Collection | Docs | Storage | Notes |
|---|---|---|---|
| `products` | 16,778 | 8.10 MB (+ 29.9 MB indexes) | The normalized catalogue — source of truth; ~470 B/product |
| `productevents` | 16,851 | 2.60 MB | All `added` so far (first-crawl effect) |
| `crawljobs` | 6 | 3.00 MB (957 kB avg!) | Finished jobs embed full product arrays — duplicated data |
| `crawlresults` | 4 | 1.98 MB (1.03 MB avg) | Legacy full-catalogue snapshots — D1 compat layer |
| `snapshots` | 4 | 94 kB | New-model history |
| `stores` | 4 | 33 kB | Scheduler input |
| `users` | 1 | 37 kB | Demo user |
| `mystores` / `competitors` / `productmatches` / `alertstates` | 0 | — | **Pipeline idle — set "your website"** |

- Two stores (prosportsae, athletix) are **HTTP 429-blocked** by their WAF
  (ParityBot UA) — that's the "0 products · 9 requests" runs, not a crawler
  bug. Miraclefitness's "1 / 1,461 products" was **JS-rendered pages with
  browser rendering off** ("http only" runs) — re-run with rendering on.
- Nothing needs clearing for size (~16 MB data + ~32 MB indexes for 17k
  products; 100 stores ≈ ~500 MB).

---

## 💱 Cross-currency + JS-rendered stores hardening (Aug 2026)

**The diagnosis (activefitnessstore.com, verified live):**

- Its product pages are **client-rendered Next.js** — the HTML shell (32 KB)
  has the title + og tags but **no price, no JSON-LD, no OG price, no
  `__NEXT_DATA__`** (the og:type is even `"website"`, not `"product"`). The
  price is fetched by JS at runtime. Crawling it "http only" stored **all
  10,456 products with price 0 / `available: false`** — same disease as
  miraclefitnessuae.
- Worse, only **504 of the 10,456 stored rows** are real products (URL ends in
  an EAN/SKU); the other ~9,950 are **blog posts, brand pages and category
  pages** that the sitemap-leaf heuristic accepted as products.
- And the currency was being **silently defaulted to "USD"** by the
  extractor fallbacks even for GCC stores (AED/OMR) — the mapper even
  discarded the real `priceCurrency` the extractors captured.

**The fixes shipped:**

1. **Product URL pattern filter** — `productUrlPattern` on a crawl (Sources →
   Configuration field): a regex tested against every discovered URL; only
   matches are crawled. For activefitnessstore: `/\d{4,}$/` keeps the
   EAN/SKU-terminated product URLs and drops the blog/brand/category pages
   (verified against 8 real URLs). Plumbed end-to-end: `CrawlConfig` →
   `CrawlRunInput` → job params → worker → engine, **including scheduled
   crawls** (Store schema got the field — the Mongoose-strict-mode lesson
   from the UA revert).
2. **Auto browser-rendering re-crawl** — when a deep crawl ran with rendering
   OFF, fetched ≥ 10 pages and extracted **zero prices**, the worker now
   appends a finding ("looks JS-rendered") and **auto-enqueues one re-crawl
   with rendering ON** (useBrowser:true → can't loop).
3. **Honest currencies + USD normalization (`priceUsd`)** — the mapper now
   carries the extracted `priceCurrency` through to ingestion;
   `Product.currency` no longer defaults to "USD" (null = unknown); a new
   **`fxService`** fetches daily USD-base rates (open.er-api.com, no key,
   cached in Mongo + in-process, graceful fallback to stale) and the ingest
   pipeline stores **`Product.priceUsd`** for cross-currency comparison.
4. **Currency-aware comparison** — `GET /api/match` rows now carry
   `currency` + `priceUsd`; the ComparePanel compares **USD when available,
   native only when both stores share a currency, else "different
   currencies"**; the "price differs" tile uses the same rule (AED 100 vs
   PKR 100 no longer reads as equal). Prices display with their native
   currency code (e.g. `440.45 AED`).

**To re-crawl activefitnessstore correctly:** restart the backend (the running
workers are on the old code), then on Sources paste `\d{4,}$` into the new
**Product URL pattern** field (keep **Auto-detect JS-rendered pages** ON) and
crawl. Expect ~500 real product URLs with real AED prices instead of 10,456
zeros.

---

## 📍 Where we are in the plan

Per `plan.md` §9 and `architecture.md`: everything through **indexed matching
and events → alerts is shipped and live-Mongo verified**. **Next: Phase 5
(productionize).**

| Phase | What it is | Status |
|---|---|---|
| **Phase 1** | Storage refactor: `Store` / `Product` / `Snapshot` / `ProductEvent` / `ProductMatch` / `MarketProduct`, indexes, dual-write + backfill | ✅ Done |
| **Phase B** | Resume state moved from SQLite → `Product.httpState` (any worker resumes any crawl) | ✅ Done |
| **Phase 2** | Worker pool + queue + scheduler (crawls left the server process) | ✅ Done |
| **Phase 3** | Indexed matching (GTIN > SKU > slug > token fuzzy) + persisted `ProductMatch` | ✅ Done |
| **Phase 4** | `ProductEvent` → `/alerts` engine (price drops %, stock, new/removed, unread/dismiss) | ✅ Done |
| **Phase 5** | Productionize: deploy (Nitro), CI, observability, auth hardening | ⬜ **Next** |

Also shipped along the way:

- **Background-crawler controls — pause / resume / cancel.** A new
  **Active crawls** page (`/crawler`, sidebar) lists every in-flight job
  (queued/claimed/retrying, paused ones included) + the last 15 min finished,
  polling every 2.5s, with per-card Pause / Resume / Cancel, live progress,
  shallow/deep badges and Track links. The Sources live panel got the same
  controls — with cancel behind the same confirmation dialog, and every
  pause/resume/cancel confirmed with a sonner toast. The engine checks a cooperative `CrawlControl` handle between
  units of work (per URL, per sitemap child, per HTML-BFS wave, per API-walk
  page); a cancelled crawl throws `CrawlCancelledError` and the job lands
  `cancelled` with **nothing persisted** (queued jobs cancel via a claim
  sweep). New queue API: `GET /api/crawl-jobs/active` +
  `POST /api/crawl-jobs/:id/{pause,resume,cancel}`. Verified: 11 live-Mongo
  E2E checks.
- **Discovery speed** — sitemap index children now fetch in parallel (6 in
  flight) and the HTML BFS crawls in waves of 6 (politeness still throttles
  every request); a 23-child sitemap index that used to serialize discovery
  for minutes is now near-parallel. The Sources ETA warm-up floor dropped
  5s → 2s so an estimate appears almost as soon as fetching starts.
- **Debug data on Active crawls** — each running card shows the claiming
  **worker id** (matches worker logs) and a **live HTTP-request count**: the
  engine counts every request through `HttpOptions.onRequest` (robots.txt,
  discovery, product fetches; retried attempts each count), reports it via
  `CrawlConfig.onRequestCount`, and the worker writes it to
  `CrawlJob.progress.requests` (throttled). `publicJob` exposes `workerId` +
  `requests`; finished rows show request totals too. Verified: engine E2E
  (exactly 4 requests for a shallow 2-product run) + queue E2E (7 checks).
- **Quick check** — manual shallow sitemap-only crawl (~1 request when nothing
  changed), not just scheduler-driven.
- **Shallow/deep awareness across the UI** — badges on the Sources live panel
  and `/crawls` history; a shallow/deep **filter toggle** on `/crawls`;
  a **"Last quick check"** strip on the Sources Store profile card.
- Honest empty states and zero-fetch "No new products" handling everywhere
  shallow results appear.

---

## 📋 Migration checklist (§9.5 of architecture.md)

Status of every item in `architecture.md` §9 ("Migration path from today's
code") — the granular version of the phase table above.

### ✅ Shipped (items 1–9)

| Phase | Checklist item | Status |
|---|---|---|
| **1 — Storage** | New models + indexes (`Store`, `Product`, `Snapshot`, `ProductEvent`, `ProductMatch`, `MarketProduct`) | ✅ Done |
| | Backfill script (legacy `CrawlResult` → `Product` + `Snapshot` + `ProductEvent`) | ✅ Done |
| | Dual-write: `saveCrawlResult` also writes the new model | ✅ Done |
| | `?meta=1` read projections (cheap summaries) | ✅ Done |
| **2 — Workers** | Crawler extracted to a standalone worker + `CrawlJob` queue (claim/heartbeat) + scheduler | ✅ Done |
| | In-memory crawl server-functions → job enqueue + `GET /api/crawl-jobs/:id` polling | ✅ Done |
| | Resume state → `Product.httpState` (Phase B — cross-worker resume) | ✅ Done |
| **3 — Matching** | Indexed matching (GTIN > SKU > slug > token fuzzy) + persisted `ProductMatch` + `GET /api/match` | ✅ Done |
| **4 — Events** | `ProductEvent` → `/alerts` engine (price %/amount, severity, stock, new/removed, unread/dismiss) | ✅ Done |

### ⬜ What's left (the open items)

1. **Phase 5 — Productionize (item 10)**
   - **Auth on `/api/data/*`** — only the alerts routes are auth-protected
     today; the rest of the data API is open.
   - **Observability** — job metrics + crawl logs (nothing systematic yet).
   - **Deploy workers as separate containers** (one image, two entry points:
     `worker.mjs` pool + single `scheduler.mjs`).
   - **CI pipeline.**
2. **D1 endgame — "freeze, then drop" `CrawlResult`**
   - *Freeze (in progress):* the new read path is built and
     **`/stores/$origin` is flipped onto it** (server-paginated catalogue,
     debounced `q=`, keyset "Load more", cascade delete); `/crawls`,
     `/sources`, `/pricing` still read the legacy `CrawlResult` via
     dual-write until they're flipped too.
   - *Drop (Phase 5):* after one release on the new read path, `drop()` the
     collection in a migration script (the backfill already reproduced it).
3. **§6 read-path endpoints — ✅ built (Phase 5)** — `GET /api/stores`,
   `/api/stores/:key` (profile + latest snapshot), `/api/stores/:key/products`
   (keyset-cursor pagination + `q=` search + `$slice` sparklines),
   `/api/stores/:key/snapshots`, `/api/stores/:key/events?since=&type=`, and
   `DELETE /api/stores/:key` (cascade) — backed by the normalized collections
   (`utils/readPath.js` unit-tested, 28 E2E checks), plus frontend
   `api/stores.ts` clients + query keys. **Flipped:** `/stores/$origin` ✅
   (this session). **Still open:** flip `/crawls`, `/sources`, `/pricing`
   (the D1 "freeze" step), then drop `CrawlResult`.
   `GET /api/market/products` stays unexposed until `MarketProduct` is
   written at ingest.
4. **Accepted trade-offs / future work (monitor, don't block)**
   - **Fuzzy recall:** the token inverted index misses near-duplicates sharing
     no tokens ("Nike Air" vs "NikeAri") — a stemmed/character-ngram index is
     future work (recorded as a deliberate deviation).
   - **Long-range trends:** `ProductEvent` TTL is 90 days; older history needs
     a daily rollup collection if that becomes a product requirement (§10).
   - Identity collisions / sitemap-less stores / queue correctness — listed
     risks, mostly handled in code.
5. **Set "your website"** (`/competitors`) — `mystores`, `competitors`,
   `productmatches` and `alertstates` are all **empty** in the live DB; the
   whole compare/match/alerts pipeline is idle until a my-store origin is
   chosen and crawled. Highest-value next step.
6. **Prune terminal `crawljobs`** — finished jobs embed the full product array
   in `result` (957 kB avg doc; urbanfitness alone holds 5,082 products) — the
   same data lives in `products`/`crawlresults`. A small cleanup script that
   strips `result` from terminal jobs (keeping the last hour) is cosmetic at
   current size but frees the biggest single duplicated chunk.
7. **Clear the 0-product snapshots** stacked by the blocked stores
   (prosportsae · 2, athletix · 2) via "Clear history" on `/crawls` — they
   were HTTP-429'd by the stores' WAF (ParityBot UA), not crawl bugs.

**In short:** the entire data plane (save → fetch → match → change detection
→ alerts) is shipped and verified. What remains is the **production/cutover
layer**: auth on the data API, the new read endpoints + flipping the UI off
`CrawlResult`, observability, containerized workers, CI, and finally dropping
the legacy collection — i.e. Phase 5 + the D1 endgame — plus unblocking the
comparison pipeline by setting "your website" on `/competitors`.

---

## 🔄 Before → Now: what changed and why it's better

This maps to the five questions `architecture.md` was written to answer.

### 1. Saving — how we store 100+ stores × 10k+ products

- **Before:** one fat `CrawlResult` doc per crawl holding the *entire product
  array* (~10 MB per store). History meant duplicating the whole catalogue for
  every snapshot. 100 stores → gigabytes, slow reads.
- **Now:** a normalized model — `Product` holds the *current* state (one doc per
  product, sparse-indexed `gtin`/`sku`/`slug`, capped `priceHistory`, resume
  `httpState`); `Snapshot` is metadata-only (capped 10/store); `ProductEvent`
  is the change log (TTL 90d). No duplicated catalogues. The legacy
  `CrawlResult` stays as a compat layer, and list UIs use `?meta=1` summaries
  (~10 KB instead of 10 MB).

### 2. Fetching — least compute

- **Before:** crawls ran *inside the server process* (an SSR function) — a big
  crawl blocked the whole API. Every run was a full re-crawl that re-fetched
  everything.
- **Now:** crawls run in **separate worker processes** pulled from a Mongo
  `CrawlJob` queue (scale workers independently, API stays responsive); a
  **scheduler** ticks shallow/deep cadences; **resume state lives in Mongo**
  (`Product.httpState`), so *any* worker picks up where another stopped. The
  big win: **shallow sitemap-only checks** (~1 request when nothing changed) —
  new products only, never touching the stored catalogue.

### 3. Comparing — efficient matching

- **Before:** the browser loaded two full catalogues and ran an O(n·m) fuzzy
  scan on every poll — minutes of UI freeze at scale (mitigated only with a
  pair limit and async chunking).
- **Now:** matching is **indexed and server-side**: exact tiers are sparse-index
  lookups, fuzzy candidates come from a token inverted index **plus a trigram
  tier for near-duplicate names** (the full cross product is never enumerated),
  results are **persisted in `ProductMatch`**, unchanged crawls **skip
  matching entirely** (no-op gate), and the Competitors ComparePanel reads
  **paginated `GET /api/match`** — zero recomputation on page load, no browser
  catalogue download.

### 4. New/removed products — change detection

- **Before:** a diff was recomputed on every page load by comparing full
  snapshots in the browser.
- **Now:** the ingest pipeline does an **identity-set diff at crawl time** →
  `ProductEvent` rows (added/removed/price/stock). Everything downstream reads
  events with **zero recompute**: "what's new" diffs, sparklines, biggest
  movers, and now the **real `/alerts` engine** (price-drop % + amount, severity
  tiers, per-user unread/dismiss).

### 5. Getting there

- **Before:** a prototype UI on a mock dataset with one hardcoded crawler.
- **Now:** a real client/server app (JWT auth, MongoDB), a phased migration with
  a **backfill script**, dual-writes that keep old data readable while the new
  model fills in, and every phase verified with unit tests + live-Mongo E2E
  before moving on.

---

## In one line

We went from *"crawl in the server, store duplicate snapshots, compare in the
browser, diff on every read"* → *"crawl in scalable workers with resume +
shallow checks, store normalized current-state, match via indexes, and read
events instead of recomputing"* — which is what makes the 1M-product target
actually feasible.

---

*Living document — refresh it as phases ship.*
