# Parity — Project Summary

A condensed status snapshot: where the plan stands, the bug fixed this session,
and how the architecture changed from "before" to "now".

---

## 🐛 Bug fixed this session — discovery misclassified 37k SEO landing pages as products

**Symptom:** `lifetimefitnessstore.com` deep crawl sat at **0 / 31,419
products** through ~14,500 requests across two runs (engine `eb33dfc` then
`f94d88b` — the second run was the versioning feature doing its job: backend
restarted, stale heartbeat released the job, a new worker re-claimed it with
the new engine). Heartbeats fresh, requests climbing, zero products — it
looked healthy and was doomed.

**Root cause:** the store's sitemap (`sitemap_ae.xml`) is ~94% GCC-style SEO
landing pages — per-product-type × city slugs ending in `-in-<place>`
("treadmills-in-al-qusais", "yoga-strap-in-abu-dhabi"). The flat
`filterProductSitemapEntries` rule classified **39,427** of 50,597 URLs as
products; the HTML extractor correctly returned **null on every one** — these
pages carry no `Product`/`ItemList` JSON-LD (audited: only
`WebSite`/`Organization`/`SportingGoodsStore` storefront schema), and the store
has no product sitemap (`wp-sitemap-posts-product-*`, `product-sitemap.xml`
→ 404), no `/shop/`, no public WooCommerce API. So the fetch loop dutifully
burned ~1.9 req/s × 1–3 MB pages on a queue where nothing could ever parse;
a full run would have finished ~6h later with 0 products and ~39k
extraction-miss failures.

**Fix:** `crawler/discover/index.ts` — `filterProductSitemapEntries` now
rejects slugs whose last segment ends `-in-<place>` (explicit product-base
URLs `/products/`, `/dp/`, `/item/`, `/shop/<cat>/<prod>` still win). Verified
with the engine's own code against the live sitemap: **39,427 → 43** classified
URLs, zero landing pages left. The 43 survivors also extract null — this store
genuiely exposes no parseable catalogue, so a re-crawl will end fast and honest.

**Verified:** crawler typecheck ✅ · engine's own classifier + extractor probe ✅

> **Deployed + confirmed (Aug 15):** backend restarted with the fix; a live
> re-crawl of lifetimefitnessstore now discovers **43** URLs (was 31,419) and
> finishes in **22–52 s** — `0 products, 43 failed [43 extraction-miss · 0
> http]`, the honest answer: the store loads fine but exposes no product
> schema anywhere. Also fixed the worker's completion line (it read the
> capped failure list from `sanitized.stats.failures` — always empty — so its
> split read 0/0; it now reads `sanitized.failures` and matches the engine's
> line). The mid-run observability gap this exposed (fetched/failed counters
> only persist at completion, so a doomed crawl looks healthy for hours) is a
> known follow-up.

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
file** (`backend/workers/worker.mjs`). `'../crawler/index.ts'`
therefore landed in `backend/frontend/…` (one level too shallow) instead of the
sibling `frontend/` package at the project root. The error message shows the
wrong path exactly.

**Fix:** `backend/workers/worker.mjs` now loads
`'../crawler/index.ts'` (with a comment explaining why it's
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

### UA experiment → reverted (decision recorded) → re-opened per-store (Aug 11)
- A browser-like Chrome UA got HTTP 200s where `ParityBot/1.0` got 429s on
  prosportsae.com / athletix.ae (curl-verified). It was implemented end-to-end
  (engine → queue → schedule → UI field) and then **fully reverted by
  decision** — ParityBot stays, and blocked stores rely on the Tier 2
  residential proxy + slower concurrency instead.
- **Re-opened scoped (Aug 11):** dawlance.com.pk **403s every ParityBot
  request** while a Chrome UA gets 200s from the same IP (verified live — the
  same class as prosportsae/athletix). Since it's UA-based, a residential
  proxy can't fix it. The old global change returned as a **per-store opt-in**:
  Sources → Configuration → **User agent** select (ParityBot default / Browser
  Chrome). The `'browser'` sentinel flows Store → job → worker → engine
  (`resolveUserAgent` in `core/http.ts`, single source of truth), robots.txt
  is still parsed for the browser token, and the pre-crawl analyzer probes
  with the same UA.

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

## 🏪 Store-detour detection — corporate sites that link to their real store (Aug 11)

haier.com/pk crawled 888 pages → **1 product**: it's a corporate dealer
catalog — product pages have 0 JSON-LD and 0 price markers (verified live),
so there's genuinely nothing to extract. But every page's **"Buy Now"** button
links to **haiermall.pk** — the real priced storefront.

**Shipped:**

1. **`analyzeHomepage` store-host detection broadened** — `STORE_HOST_RE` now
   covers `mall`/`market`/`marketplace`/`outlet`/`deals` plus a mid-word
   `mall(\\.|$|-)` check (haiermall.pk embeds "mall" mid-word, which the old
   boundary regex missed) and an anchor-label check (`buy now` / `shop now` /
   `order now`). Verified on the live haier homepage AND product page →
   `externalStoreLinks: [haiermall.pk]`.
2. **Run-level aggregation** (`runCrawl`) — every product page that fails
   extraction is anchor-scanned (the HTML is already in hand, best-effort);
   a run that extracts **zero products** but keeps finding store-like hosts
   appends a finding: *"its pages keep linking to haiermall.pk — crawl that
   domain instead, the prices live there"* with a one-click **Crawl X
   instead** action.
3. **Website Intelligence Analyzer** now reports `homepage.externalStoreLinks`
   in its profile; the Sources analysis panel shows them with the same
   crawl-instead buttons.

Not retroactive: the finding appears on the next crawl (or Run analysis) of
haier.com — the existing 0-product snapshot is untouched.

### Follow-up (Aug 11) — the two remaining 0-product crawls explained + fixed

- **Dawlance (0 products, 7 requests) was a REAL bug, now fixed.** Its
  product sitemap lives at `/medias/Product-en-PKR-*.xml` (SAP/Hybris
  convention), and `isNonProductSitemap` matched the word `media` ANYWHERE in
  the URL — so the whole catalogue was silently dropped as "media junk". Fix:
  the filter now tests only the **basename** (with word boundaries), plus
  Hybris-aware rules (`Product-*` = product sitemap, `Homepage-` /
  `Category-` / `Content-` = skip), so the walk keeps + trusts the product
  child wholesale. Verified against the live dawlance index (383 product URLs
  retained; 13-case unit sweep passes; typecheck + jest 30/30).
- **The honest remainder:** dawlance's product AND category pages return
  **HTTP 500 from this machine even with a full Chrome header set** (12/12
  sampled) while the homepage 200s with prices — Akamai Bot Manager serves
  the homepage for fingerprinting but 500s deep paths. UA override can't fix
  that; the Tier-2 residential proxy is the path. The re-crawl will now
  honestly report "383 discovered, pages 500-blocked" instead of
  "0 discovered".
- **Haier store-detour trigger widened:** it fired only at exactly 0
  products, but haier squeaked out 1 of 883 — so the haiermall.pk hint never
  appeared. Threshold is now `≤ 5 products` (with a count-aware message).

---

## 🧹 Catalogue purity + compare UI (Aug 8–9)

**The "blogs/privacy/terms still coming in" fix — three layers, global for
every store:**

1. **Any-depth junk filter** (`discover/index.ts`) — the old blocklist only
   tested `segment[0]`, so a locale prefix (`/uae-en/`) hid every junk page
   behind segment 1. `hasJunkSegment()` now checks ALL path segments
   (blog/privacy/terms/collections…) and strips them from every sitemap
   source; plus **product-base dominance** (a firm 60%+ majority under
   `/product(s)/` = the catalogue; non-base URLs dropped).
2. **Ingest guard** (`crawlSync`) — junk-segment rows are dropped before they
   become Products (second net for HTML-BFS/legacy paths; identity-bearing
   products always survive; an all-junk crawl can't mass-delete the
   catalogue).
3. **Single source of truth** — `backend/crawler/discover/junk-segments.ts`
   (`JUNK_SEGMENT_RE`, `hasJunkSegment`, `PRODUCT_BASE_RE`, `isProductUrl`)
   shared by the crawler, `crawlSync` and the `tools/` ops scripts via
   `await import()` — a probe script had already drifted with extra terms;
   that drift class is now impossible.

**Applied:** 191 urbanfitness junk rows purged (soft-delete), 1,801
activefitness non-products purged, matches reconciled — the surviving matches
are real products with real USD comparisons (51/52 urbanfitness matches have
both-side USD). Store cards post-cleanup: activefitness 8,667 · urbanfitness
4,823 · marshalfitness 1,311 · prosportsae 1,607 · miraclefitness 1.

**Compare UI (Aug 9):** match rows are now **side-by-side product cards** —
your product + price vs theirs — with the shared `StorePill` (ink = your
store, amber = competitor), visible USD estimates, best-price + out-of-stock
chips, and a fixed-width **grid** layout (the `table-fixed` Cheapest column
collapsed to 0px on narrower tables and overlapped the Difference column).

**Housekeeping (Aug 9):** `tools/` pruned 38 scratch probes → 2 reusable ops
scripts (junk purge/check); `backend/scripts/` trimmed to the two `npm run`
entries (backfill, reconcile-matches); this doc + `plan.md` + `AGENTS.md`
synced.

---

## 🛡️ Removal-guard bug fixed (Aug 7) — blocked runs must never wipe the catalogue

- A crawl that **discovered URLs but fetched 0** was treated as authoritative
  (the guard trusted `discovered > 0`), so activefitnessstore's
  10,522-discovered / 0-fetched run ("No product data found" on every page —
  the workers were still on pre-fix code and never rendered the JS shell)
  **soft-deleted all 10,462 products**. prosportsae's 401-product catalogue
  was wiped the same way by the broken URL-pattern run (discovery counted
  before the pattern filter zeroed the set).
- **Fix:** `crawlSync` `authoritative` now requires `products.length > 0`
  (parsed products — the honest "we really saw this store" signal), never
  `discovered`. Verified: backend jest 30/30.
- **Recovery:** `scripts/restore-catalogues.js` restores fully-wiped stores
  (conservative: partial soft-deletes are intentional and untouched).
  Restored 10,463 products: activefitnessstore 10,462 + miraclefitnessuae 1,
  plus prosportsae 436 (targeted — snapshot forensics proved it was bug
  damage, not real removals; 441 available again).
- Also confirmed: **activefitnessstore.com is a multi-region storefront** —
  robots.txt declares 12 sitemaps (om/bh/qa/kw/sa × en/ar + root). All five
  regions serve the **same products at different prices/currencies**, so
  crawling ONE region (om/en — the first robots.txt entry) is correct;
  crawling all would 6×-duplicate the catalogue. Region selection is a
  possible future feature; `priceUsd` already makes cross-currency
  comparison work.

---

## 🔧 This session — P4 close-out + matcher purity (Aug 15)

Three roadmap items shipped, all verified:

1. **Worker code versioning (P4)** — the worker stamps `crawlerVersion`
   (backend package version + git short SHA read at boot) on the job at
   claim: first forced beat + the run-log opens with
   `engine vX — restarting the backend deploys this`. Exposed via
   `publicJob`, shown as an `engine <v>` chip on the Active crawls debug
   strip. Live-verified: `1.0.0+eb33dfc` on a real job, matching the
   deployed commit — a stale worker is now visible, not a mystery.
2. **Failure classification (P4)** — `CrawlFailure.kind`
   (`'extraction'` = page loaded, nothing parsed; `'http'` = fetch failed:
   timeout / rate-limit / WAF / network), set at the two engine push sites
   + discovery failure. The run-log finish lines (engine AND worker) split
   the count (`[N extraction-miss · N http]`); the results panel badges
   each row (muted `no data` vs red `http`) and the empty state reads
   honestly ("every page loaded, nothing parseable" vs "some pages
   blocked"). Legacy results without `kind` render unchanged.
3. **Matcher purity (P3 watch)** — non-product URLs excluded from the
   matcher entirely: all candidate sets (exact tiers, my own catalogue,
   trigram tier) filtered by the shared `hasJunkSegment` classifier unless
   the doc carries gtin/sku (the ingest guard's identity rule, so matching
   and ingestion can't disagree). Junk-to-junk fuzzy pairs can no longer
   form; existing pairs clear on the next per-pair reconcile.

## 🎨 This session — UI polish + 1M-scale readiness (Aug 15)

**UI polish (audit-driven, not a redesign — the warm-editorial design system
was already intentional):**

1. **`Card` primitive** (`components/ui/card.tsx`) — the pages had 40+
   hand-rolled `border border-border bg-card` divs that skipped the radius;
   the new Card applies `rounded-md` + a whisper of shadow from the tokens.
   Migrated the visible surfaces: every Sources panel (setup / analysis /
   progress / results / config / schedules), the store profile card, Active
   crawls job cards + finished list, the /metrics page (tiles, worker list,
   legend), login, the dashboard + catalogue + products + reports + store
   catalogue tables/charts, the competitors compare slots and the diff
   tiles. The `<ul>` list surfaces got their own primitive — **`CardList`**
   (renders a `<ul>` with the same surface + dividers + clipped corners so
   list semantics stay valid) — and all 14 of them were migrated: alerts
   feed, dashboard gaps + competitor snapshot, catalogue invest/brand
   lists, pricing gaps/positioning/movers, crawl diff products, crawl-row
   discovery + preview lists, schedules, and the results-panel products
   list. Zero old-style list surfaces remain.
2. **`EmptyState` component** (`components/common/empty-state.tsx`) — one
   icon + title + description treatment replacing the scattered plain-text
   empties: Active crawls ("No crawls running"), /metrics ("No worker
   holds a job"), /crawls (with the query/type-filter-aware copy).
3. **/metrics page elevated** — stat tiles are now proper cards; the legend
   strip, worker list and empty state use the primitives.

**1M-scale readiness:**

1. **Terminal-CrawlJob pruning** (`npm run prune-terminal-jobs`, dry-run by
   default, `--apply` to strip): finished jobs embed the full product array
   in `result` (~1 MB each, the biggest duplicated chunk); the script
   strips `result` from terminal jobs older than a keep window (default
   1h, `KEEP_MS` to change) while KEEPING the run log. Verified live:
   dry-run connects, finds 0 to prune (recent jobs are inside the window;
   older ones were TTL'd).
2. **`.env.example` restored** (was deleted in the previous commit; docs
   reference it) — reconstructed from git history.
3. **Pagination audit — clean**: no full-catalogue reads remain on either
   side. Frontend product fetches all use the paginated `/stores/:key/
   products` endpoints; `/data/pricing` + `/data/matched-products` are
   server-side aggregates over metadata + persisted `ProductMatch` rows
   (never full product arrays).

## 🩺 This session — store-health pass (Aug 15)

Flags the stores that will return ~0 products BEFORE a crawl burns worker
hours (the lifetimefitnessstore lesson: 39k classified landing pages, 6h of
fetching, 0 products). The analyzer already gathered every signal — health is
a pure function over the probed profile:

1. **`assessStoreHealth(profile)`** (`crawler/analyze.ts`) — a verdict +
   0–100 score + human-readable flags over the probe signals: public store
   API (strongest), Product schema with prices on a sampled product page
   (the decisive extraction signal), product sitemap size (post-classifier,
   honest), WAF blocking (dawlance class — "blocked", not "no-products":
   fixable with a proxy/browser UA), corporate-vs-store (haier class), and
   csr-shell rendering (no server schema ≠ no products — the browser render
   would reveal them). Verdict priority: API > blocked > corporate >
   no-products > unclear. Attached to every `WebsiteProfile`.
2. **Persisted on the Store** — new `Store.health` subdocument written by
   `POST /api/analyze` AND the pre-crawl gate (`analyzeBeforeCrawl`), so the
   Sources profile + /crawls list flag 0-product stores without re-analyzing.
   Exposed via `storeSummary` (`GET /api/stores`).
3. **Pre-crawl warning** — a `no-products` / `corporate` verdict now sets the
   job's `analysis.warning` (like the WAF warning) + a `healthVerdict` on the
   analysis snapshot, so a doomed crawl is flagged in the progress panel
   before it starts.
4. **UI** — shared `HealthChip` (verdict-colored): banner atop the analysis
   results (verdict + score + reasons), chip on the Sources store profile,
   chip next to each domain on /crawls, chip beside the strategy tier in the
   progress panel's analyze-first row.

**Live-verified against real stores:** lifetimefitnessstore → **no-products /
15** (43 landing-page URLs, no schema — exactly the doomed case);
marshalfitness → **healthy / 70** (priced Product schema + 1,312 sitemap
URLs); activefitnessstore → **healthy / 25** (11,209 URLs, HTML-extractable);
dawlance → **no-products / 0** (no schema, no sitemap, WAF-gated — the honest
answer for the default-UA probe). Verdicts persisted to the store list.
Backend typecheck ✅ · jest 30/30 ✅ · frontend tsc ✅ · lint ✅ · build ✅.

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
| **Phase 5** | Productionize: deploy (Nitro), CI, observability, auth hardening | 🔄 **In progress** |

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
   - **Auth on `/api/data/*`** — ✅ done (this session): `router.use(auth)`
     on the whole data router (the alerts routes were already protected).
     `/api/auth/*` + `/health` stay open; the frontend already attaches the
     JWT on every request and redirects to login on 401.
   - **Auth on the remaining routers** — ✅ done: `/api/stores`,
     `/api/crawl-jobs`, `/api/match`, `/api/analyze`, `/api/proxy` all
     `router.use(auth)`. The browser http client was already token-bearing;
     the TanStack Start SERVER functions in `src/lib/crawl.ts` (which fetch
     the backend directly from Nitro) now recover the JWT from a mirrored
     `parity.token` cookie (set by `lib/http.ts` on login) and forward it as
     the Authorization header — so crawl/analyze/proxy flows keep working.
   - **Observability — job metrics** — ✅ `GET /api/data/metrics`
     (`controllers/metricsController.js`): queue depth by status, live
     worker picture (fresh/stale heartbeats — same
     `PARITY_HEARTBEAT_TIMEOUT_MS` the release sweep uses), 24h/7d
     throughput by type with success/failure rates, avg/median/p95
     durations, request totals, active schedules. All derived live from
     `CrawlJob` — no counters to maintain. **UI:** new **/metrics** page
     (`src/pages/_authenticated/metrics/`, sidebar → Operations) renders
     queue tiles, worker liveness + per-worker job list, and 24h/7d
     throughput cards, polling every 10s via `useMetrics()`.
   - **Observability — crawl logs** — ✅ done (this session): a structured,
     capped **run log lives on each CrawlJob** (`progress.log`, 200-line
     cap). The engine got an `onLog` callback (start/robots/discovery
     done/finished lifecycle lines + 429 rate-limit warnings from
     `core/http.ts`); the worker buffers the emissions and its own
     lifecycle lines (claimed → crawling → finished/cancelled/failed) and
     flushes them with the heartbeat — the terminal lines ride ATOMICALLY
     with the `completeJob`/`failJob`/`cancelJob` status write (the
     heartbeat timers are torn down right after, so the final flush can't
     race). `publicJob` exposes `log`; the UI renders it via the new
     `RunLog` component (`components/crawls/run-log.tsx`, collapsible,
     level-tinted, auto-scroll) in the Sources progress panel (open by
     default), on Active crawls cards (collapsed), AND on finished crawls:
     the results panel renders it open by default (the reason behind a
     result stays visible after the job ends — the job snapshot the panel
     renders carries the full log, and a refresh re-fetches it from the
     still-live job), and cancelled/failed runs get theirs next to the
     status alert (the worker's terminal line rides the same write).
     Verified live with a real shallow crawl: all 7 lines landed — worker
     `shallow check → crawling` + engine `started → robots.txt → discovery
     done → finished` + the worker's final `finished` line flushed with the
     `done` write, still served 10 min after finish.
   - **Deploy workers as separate containers** — ❌ removed by decision
     (this session): the Docker artifacts were deleted (no Dockerfiles, no
     `docker-compose.yml`). The prod-SSR pieces that were built for it
     REMAIN because they're not docker-specific: `src/server.ts` now proxies
     browser `/api/*` calls to Express (the built Nitro server has no Vite
     dev proxy — without it, prod 404s every API call; JWT header passes
     through), and `server-entry.mjs` + `npm start` boot the built server
     via `h3`'s `toNodeHandler` (validated: SSR 200, `/api` 401 no-token /
     200 with-token).
   - **CI pipeline** — ❌ removed by decision (this session):
     `.github/workflows/ci.yml` was deleted along with the Docker artifacts
     (no CI config remains in the repo).
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
