# Parity — Improvement Plan (Aug 7, 2026)

How we take things now, how we add new things, and how we improve —
so every change has a stated reason and a way to verify it.

North star for every item below: **real, comparable prices in the catalogue.**
Everything else (matching, alerts, reports) is idle until that is true.

---

## 1. How we take things now — current state

### Working (verified this session)
| Area | Status | Evidence |
|---|---|---|
| Worker pool + queue + scheduler | ✅ | 3 workers, heartbeats, pause/resume/cancel, resume state in Mongo |
| Discovery pipeline | ✅ | platform detection, robots.txt sitemaps (all 12 for activefitness), HTML BFS, WooCommerce + BigCommerce API probes |
| JS-render decision + price extraction | ✅ fixed | activefitness page: 33 KB shell → 232 KB DOM → `price: 90, currency: OMR` (E2E script) |
| Cross-currency | ✅ | `priceUsd` written at ingest, USD-first comparison, honest currencies (no silent USD) |
| Matching + events + alerts | ✅ | indexed GTIN > SKU > slug > fuzzy, `ProductMatch`, `ProductEvent`, `/alerts` |
| Store read path | ✅ | `/api/stores` counts filter out purged pages (`lastSeenAt > epoch`): activefitness 8,667 · urbanfitness 5,014 · prosportsae 1,607 · marshalfitness 1,311 |

### Fixed and LIVE (backend restarted Aug 7 — item 1.1)
All five fixes are loaded into the running workers (workers load code at
spawn; the restart is the deploy step):

1. **Rate limiter** ✅ 500 → 20,000 requests / 15 min + localhost exempt
   (it locked the whole API mid-crawl — the "Progress updates stopped" banner).
   Proven: API answered 200 on every poll through a live crawl.
2. **`needsBrowserRender` fix** ✅ — `og:title` no longer counts as content-rich;
   loading-spinner shells (ant-spin etc.) now trigger a browser render.
   Proven: activefitness → render, urbanfitness → no render.
3. **OpenGraph extractor fix** ✅ — no more `price: 0` product shadowing the chain.
4. **HTML heuristics fix** ✅ — currency-code prices (`OMR 90`), thousands
   separators (`1,000`), keyword window across tags.
   Proven: E2E extracts `price: 90 / currency: OMR` from a live activefitness page.
5. **Removal-guard fix** ✅ — a crawl is authoritative for removals only when it
   **parsed products** (not just discovered URLs). This is the data-loss bug:
   activefitness's 10,522-discovered / 0-fetched run wiped all 10,462 products.
   Proven: the dead 0-product 1.2 crawl left the catalogue intact.

### Data state (live DB, Aug 8 — post-cleanup)
| Store | Catalogue | Priced | Currency | priceUsd | Note |
|---|---|---|---|---|---|
| activefitnessstore | **8,667** | 875 | OMR | 875/875 | ✅ junk purged (was 10,464; 1,801 blog/brand/category/admin pages soft-deleted); all real OMR + converted |
| urbanfitnesscart | **4,823** | 4,513 | **AED** | 4,513/4,513 | ✅ re-crawled + **191 non-product pages purged** (blog/policy/collection/category); 4,442 silent-"USD" labels backfilled to AED |
| marshalfitness | 1,311 | 1,309 | **AED** | 1,309/1,309 | ✅ re-crawled (1310/1310, 65 requests — etag resume); labels backfilled |
| prosportsae | 1,607 | 1,606 | **AED** | 1,606/1,606 | ✅ healed by the 06:00 crawl + backfill; card restored (was 28 — out-of-stock-heavy) |
| miraclefitnessuae | 1 | 1 | USD | 1 | JS-rendered; needs browser ON |

Honest currency mix: **AED 7,427 · OMR 875 · EUR 1 · USD 1** — no fabricated
labels. Every priced product carries `priceUsd` (fxService at ingest).

### Known blockers
- **prosportsae / athletix** — WAF rate-limits (HTTP 429) sustained crawling
  for `ParityBot/1.0`; the 429s are **intermittent** (a direct probe answers
  200 while the crawl gets 429s). Documented decision: ParityBot stays; the
  fix is the Tier-2 residential proxy (not built).
- **miraclefitnessuae** — client-rendered; must crawl with auto JS rendering ON.
- ~~Comparison pipeline — matches were junk-to-junk~~ ✅ **resolved (Aug 8):**
  the 177 empty-price matches were URL-slug/fuzzy pairings of non-product
  pages; after the purge + reconcile the matches are real products with real
  USD comparisons (e.g. LiveUp Medicine Ball 35 OMR → $91.03 vs 217 AED →
  $59.09; Concept 2 Indoor Rower $1,508.46 vs $1,497.35).

---

## 2. How we add new things — the process

The pattern that worked this session becomes the standing rule:

1. **Ground truth first.** Live-DB queries and curl probes before touching
   code. Never trust a number on a screen — verify it.
2. **Explain the mechanism before fixing.** If we can't state exactly why
   something happens (e.g. *"the guard trusted `discovered > 0`"*), we don't
   change it yet.
3. **One root cause per change.** Small, surgical edits. No drive-by
   refactors while debugging.
4. **Prove it end-to-end.** Every fix gets a runnable proof (E2E render +
   extract script, render-decision probe, region-sitemap probe). The frontend
   has no test runner, so verification scripts are the convention; backend
   changes run `jest` (30/30 baseline).
5. **Protect data.** The removal guard now requires parsed products (the
   damage class the `restore-catalogues.js` script healed is guarded at the
   source, so that one-off recovery script was retired with the Aug 9
   cleanup); snapshot forensics before restoring partial wipes.
6. **Document the decision.** Dated notes in `summary.md` / `architecture.md`
   (the Aug 2026 convention) — the docs are the project's memory.
7. **Restart + re-verify.** After any crawler fix, restart the backend and
   re-run the proof. Stale workers are the #1 source of "it works on my
   machine" surprises here.

New-store intake (the "how is this built?" rule):
- Before adding a crawl strategy for a site: **probe it first** — platform,
  public API, JSON-LD, rendering mode, bot protection — and record the answer.
- A new store type goes through: probe → pick strategy → verify on one live
  page → ship. The Website Intelligence Analyzer (P2 below) formalizes this.

---

## 3. How we improve — the roadmap

### P1 — Unblock the pipeline (first, everything else depends on it)
| # | Item | Status | Why | How to verify |
|---|---|---|---|---|
| 1.1 | **Restart the backend** | ✅ **done (Aug 7)** | Applies all 5 fixes; nothing running, so it was free | Proven: API 200s through a live crawl; render-decision checks pass; marshalfitness landed an `AED` priced product |
| 1.2 | **Re-crawl activefitnessstore** (no URL pattern, auto render ON) | ✅ **done (Aug 8)** — capped gentle crawl finished: 338/338 products with real OMR prices | 10,462 products with real OMR prices + GTINs = the first real matching dataset | **Verified live DB: 331 priced, 331 with `priceUsd`** (Animal Cuts 95 OMR → $247.08); store card preserved at 10,462; guard held (removed: 0) |
| 1.3 | **Clear the stacked 0-product snapshots** (prosportsae/athletix blocked runs) | ✅ **done (Aug 8)** | History pollution | **17 zero-product snapshots deleted**; per-origin history now reads clean (5 origins, 1–2 snaps each) |
| 1.4 | **Set "your website"** on `/competitors` | ✅ **done (Aug 8)** | The whole match/alerts pipeline is idle until a my-store origin exists | **User set it in-app: `mystores` doc "My store" → https://activefitnessstore.com/** (DB-verified) |

**✅ P1 COMPLETE (Aug 8).** All four items shipped. The north star is met
for activefitness: real OMR prices in the catalogue, `priceUsd` conversion
live, removal guard holding. Matching (P3) now has its anchor — the next
phase can start.

**Session status (Aug 7 → Aug 8):** **1.1 ✅** restart + proofs. **1.2 was NOT
the WAF — the real root cause was a code bug.** The engine's product fetch
loop called `fetchWithRetry` directly and read `response.text()`, but
**`fetchText` is the only function that applies the auto-render decision**
(`needsBrowserRender` → headless Chrome). The render wiring was only used by
*discovery* (sitemaps, platform probes) — so **"auto JS rendering" never
worked for product pages**: every Next.js shell went raw to the extractor,
found no structured data, and failed with "No product data found". The
crawls weren't just blocked — they could *never* have extracted prices. The
E2E/fetchText repros worked because they render explicitly; every real crawl
failed.

**Fix (Aug 8, live):** `core/http.ts` gained `fetchHtmlWithStatus` (the
status-aware variant of `fetchText` that applies the same render decision)
and `index.ts`'s fetch loop now routes the HTML chain through it. Proven by
the worker-config repro on the real engine: **11/12 pages rendered and
extracted real OMR prices** (Sjcam 35, Knight Shot Cue Stand 65, Axox 219…)
where the identical run failed 12/12 before the fix. Supporting fixes in the
same session: capped crawls now **stratify their URL sample across the whole
discovered set** (a 400-page cap no longer slices the head of the list where
brand/category pages cluster) and carry a `capped` flag so they **skip
removals and never zero the Store `productCount`** (the 400-brand-page run
had zeroed the store card to 0 while 10,462 products sat intact).

**1.2 COMPLETED (Aug 8):** the capped gentle crawl (400 pages, 2 concurrent,
1 s delay, browser ON, no pattern) finished at 05:03 UTC — **338 products,
338/338 with real OMR prices, 331 persisted with `priceUsd` conversions**
(e.g. Animal Cuts Fat Burner 95 OMR → $247.08). The `capped` guard held:
the snapshot records `removed: 0` and the store card stayed at 10,462 — the
400-page sample neither wiped the catalogue nor zeroed the card. The 62
failures were brand/category landing pages (`/om/kettler`, `/om/dunlop`…)
mixed into the "product" sitemaps — the known discovery misclassification,
listed in P4.

**Ops lesson (Aug 8):** nodemon watches `*.*` under `backend/`, so **creating
any diagnostic script in `backend/scripts/` restarts the whole backend** and
kills the crawling workers mid-run (18 restarts this session — each one
released the claimed job). Diagnostic scripts now live in `tools/` at the
repo root and require backend modules via `createRequire`; the backend stays
untouched until a restart is intentional. **Aug 9 cleanup:** `tools/` was
pruned from 38 scratch probes to the two reusable ops scripts (junk purge +
check); `backend/scripts/` keeps only the two `npm run` entries.

**Extractor false-positive fixed (Aug 7):** the rendered Next.js DOMs embed
RSC serialization payloads in `<script>` tags whose `$1` / `$22` reference
tokens matched the `$`-symbol price regex as a bogus **"1 USD"** price on
~half the pages. `html-heuristics.ts` now strips `<script>`/`<style>` blocks
before scanning (the visible price is never in a script) plus a
letter-boundary guard on the number. Re-verified live: **8/8 real product
pages extract real OMR prices** (90 · 1,580 · 130 · 60 · 45 · 25 · 10 · 10).
⚠️ Workers load code at spawn — restart the backend before any crawl so
this fix is in the running workers.

**Non-product page filter (Aug 8, evening) — the "blogs/privacy/terms still
coming in" fix.** urbanfitnesscart.com's `/sitemap.xml` mixed **5,117 real
products under `/uae-en/product/`** with ~390 junk pages (28 blog posts,
`/uae-en/privacy-policy`, `/uae-en/terms-of-service`, `/uae-en/contact-us`,
`/collections/*` and category landing pages like "Massage Chairs 400" —
which even extracted a price from a badge). Three-layer fix:
1. **Discovery any-depth junk filter** (`discover/index.ts`): the flat
   blocklist only tested **segment[0]**, so a locale prefix (`/uae-en/`)
   hid every junk page behind segment 1. New `hasJunkSegment()` checks ALL
   segments (blog/privacy/terms/collections…) and strips them from **every**
   sitemap source — even trusted product sitemaps. Verified on the real
   sitemap: old filter kept 5,477 URLs (junk included); new keeps exactly
   5,117 with 0 junk.
2. **Product-base dominance** (`filterProductSitemapEntries`): when a firm
   60%+ majority of URLs sit under an explicit `/product(s)/` base, the base
   IS the catalogue — non-base URLs are dropped (flat-taxonomy stores with a
   50/50 mix are untouched). Known tradeoff, accepted: a base-dominant
   store's flat URLs are landing pages.
3. **Ingest guard** (`crawlSync`): crawled rows whose URL hits a junk
   segment are dropped before they become Products — a second net for pages
   arriving via HTML BFS or legacy flows. Identity-bearing products (gtin/
   sku) are always kept; if a crawl's rows were ALL junk, `products.length`
   → 0 keeps the removal guard from mass-deleting the catalogue.

**Dedup (Aug 8, evening):** the classifier now lives ONCE in
`backend/crawler/discover/junk-segments.ts` (JUNK_SEGMENT_RE, hasJunkSegment,
pathSegments, PRODUCT_BASE_RE, isProductUrl — the path is post-P6; the
crawler moved from `frontend/src/lib/crawler/` to the backend on Aug 10).
The crawler imports it directly; `crawlSync` and the `tools/` ops scripts
(junk purge + check) load it via `await import()` (Node 24 type-stripping —
the same mechanism the worker uses for the crawler engine). A probe script
had already drifted with extra terms; that class of bug is now impossible —
change the list in one file.

**Applied:** purged 191 already-ingested urbanfitness junk rows (soft-delete,
`lastSeenAt`→epoch), reconciled matches — the 52 remaining urbanfitness
matches are real products, **51/52 with both-side USD prices** (Spirit
Fitness Utility Bench 285 OMR → $741.23 vs 1,595 AED → $434.31; Concept 2
Indoor Rower $1,508.46 vs $1,346.49). Store cards: urbanfitness **4,823**
(down from 5,014 junk-inflated), activefitness 8,667, prosportsae 1,607,
marshalfitness 1,311. `tsc`/eslint/jest 30/30 green.

**Catalogue purge + cross-currency heal (Aug 8) — the "pricing is missing"
fix.** The comparison showed 177 matches with **zero prices on either side**.
Ground truth: the activefitness catalogue was polluted with **10,126
non-products** — blog posts ("10 Ramadan Health and Fitness Tips | Blog"),
brand pages ("1441 Fitness Equipment | Shop at…"), admin URLs
(`all-afs-brands`, `all-categories-for-admin`), category pages — ingested as
"products" with price 0 by the pre-discipline Aug 6 full crawl. They
outnumbered real products 10k:338 and matched *each other* by URL slug.
Three pipeline leaks made the heal necessary, not just the purge:

1. **`crawlSync` only wrote `currency`/`priceUsd` when a price *changed*.**
   Re-crawls of unchanged products kept stale silent-"USD" labels and no
   `priceUsd` → every real OMR-vs-AED match read "different currencies".
   Fixed: currency + `priceUsd` refresh on **every** product touch.
2. **Silent-USD defaults in the extractor.** `jsonld.ts` (two fallbacks) and
   `html-heuristics.ts` `guessCurrency` ended with `return "USD"` — pages
   whose currency token was missing got a fabricated "USD" label (and the
   re-crawl's checkpoint resume reused the cached wrong products). Fixed:
   unknown currency → `null`, symbol/HTML guesses stay.
3. **`fxService.toUsd` treated unknown currency as USD pass-through**
   (`priceUsd = price`), the exact "silent USD" the architecture banned.
   Fixed: null currency → `null` `priceUsd` (rate outage also degrades to
   null, never a wrong number).

**Shipped + verified:** purge soft-deleted **1,801 junk pages** (kept 8,667:
875 priced + digit/SKU-URL real products); matches reconciled (junk rows
dropped); **7,241 products backfilled** to AED with recomputed `priceUsd`;
`/api/stores` + `listProducts` exclude purged pages via the `lastSeenAt >
epoch` marker (out-of-stock rows still count — prosportsae reads 1,607, not
28). The comparison API now shows **real USD prices on both sides**
(LiveUp Medicine Ball 35 OMR → $91.03 vs 217 AED → $59.09; Concept 2
Indoor Rower $1,508.46 vs $1,497.35). `tsc`, eslint and backend tests all
green.

### P2 — Website Intelligence Analyzer (pre-flight, prevents the "10k fetched / 0 priced" class)

**The goal:** answer *"how is this site built, and what's the optimal way to
crawl it?"* in ~5 polite requests and ~10 seconds, **before** a crawl starts.
The engine already executes the strategy order (API → sitemap → HTML →
browser render); the analyzer says it out loud so a store like activefitness
(JS shell + OMR) is understood in 10 seconds instead of after a 20-minute
failed crawl.

#### Design — the 5 probes (and exactly what they reuse)

| # | Probe | Reuses (existing) | New code |
|---|---|---|---|
| 1 | **Platform + store-vs-corporate** | `detectPlatform()` (`discover/platform.ts`): robots.txt body + 1 homepage fetch → platform, kind, cms, builder, seoPlugin, server stack, generator | none (already standalone) |
| 2 | **Shopify `products.json` + GraphQL API** | fetch conventions + `probeWooCommerceApi` outcome shape (`adapters/woocommerce.ts`: `public` / `auth-required` / `unavailable`) | probe `/products.json?limit=1` and Storefront `/api/*/graphql.json`; report in the same 3-state shape |
| 3 | **JSON-LD presence** | `extractJsonLdBlocks()` + `findProductNode()` (`extract/jsonld.ts`) — walks `@graph`/`@id`, skips invalid JSON | probe homepage + 1 product URL; report blocks count, Product node present, has `price` + `priceCurrency` |
| 4 | **Bot-protection detection** | `fetchWithRetry` + header conventions (`core/http.ts`) | classifier: `cf-ray`/`server: cloudflare` → Cloudflare; `akamai-*` → Akamai; 403 + "Just a moment…" challenge → JS challenge; 429 + `retry-after` → rate-limited; `x-vercel-*`/edge headers → CDN |
| 5 | **Render-mode verdict** | `needsBrowserRender()` (`core/http.ts`) — the SSR-vs-CSR-shell classifier from the Aug 8 fix | thin wrapper classifying framework (Next `__NEXT_DATA__`/`__next`/`.mjs` bundles, Nuxt `__NUXT__`, Gatsby) + the SSR/CSR-shell/SSG verdict |

Three more signals are **already computed for free** on every crawl:
`sitemap` presence + product-sitemap ratio (`discover/sitemap.ts` —
`sitemapCandidates`, `isProductSitemap`), `robots` status (`RobotsSnapshot`
from politeness), and `homepage` store-link analysis (`analyzeHomepage()` in
`discover/homepage.ts` — the "corporate site → crawl shop.x instead" signal).

#### Output shape — `WebsiteProfile`

One typed object (same style as `DiscoveryDiagnostics` in `core/types.ts`):

```ts
interface WebsiteProfile {
  origin: string;
  analyzedAt: string;
  platform: { name: string; kind: "store" | "corporate" | "unknown"; signal: string };
  server: string | null;
  api: { shopifyProductsJson: "public" | "unavailable"; graphql: "public" | "auth-required" | "unavailable" };
  jsonLd: { blocks: number; productOnHomepage: boolean; productOnProductPage: boolean; hasPrice: boolean };
  protection: { provider: "cloudflare" | "akamai" | "rate-limited" | "none" | "unknown"; evidence: string };
  rendering: { verdict: "ssr" | "csr-shell" | "ssg" | "unknown"; framework: "next" | "nuxt" | "gatsby" | "plain" | "unknown" };
  sitemap: { found: boolean; urls: number; productSitemap: boolean };
  robots: { status: RobotsStatus; crawlDelayMs: number | null };
  recommendation: { tier: "API-first" | "sitemap-HTTP" | "sitemap-browser" | "HTML-BFS" | "manual"; notes: string[] };
}
```

#### Recommendation rule (mirrors how the engine already behaves)

1. **API-first** — Shopify `products.json` public, or WooCommerce/BigCommerce
   API public (reuse the existing adapter probe outcomes)
2. **sitemap-HTTP** — product sitemap + content-rich pages (no render): the fast path
3. **sitemap-browser** — JS shell detected (the activefitness class): sitemap + `useBrowser: true`
4. **HTML-BFS** — no sitemap → HTML link-graph crawl fallback
5. **manual** — WAF present → proxy + slower concurrency + `productUrlPattern`, or skip

#### Form factor & integration

- **Phase 1 (CLI): ✅ shipped (Aug 9).** `node tools/analyze.mjs <url> [--json]
  [--budget=N]` — imports the type-stripped TS directly (Node 24, the same
  mechanism the worker uses), shares the crawler's `HttpOptions` (politeness
  throttle + robots gate + a hard request budget defaulting to 20), and
  prints the profile as a readable report. This is the "10-second answer"
  for any new store.
- **Phase 2 (UI): ✅ shipped (Aug 9).** `POST /api/analyze`
  (`backend/routes/analyze.js` + `controllers/analyzeController.js`) runs the
  SAME type-stripped analyzer the CLI uses (Node 24 import of
  `backend/crawler/analyze.ts` — post-P6 path; cached per process — the
  worker's loading mechanism), taking `{ origin, proxy? }` and returning the full
  `WebsiteProfile`. The Sources page renders a **Website analysis** section
  (`components/sources/store-analysis-panel.tsx`) below the store profile:
  a **Run analysis** button fires the probes without enqueuing a crawl, the
  profile grid shows platform/API/protection/rendering/sitemap/probe count,
  a **recommendation badge + one-line note** explains the tier, and
  **Apply recommendation** pre-fills the crawl config (enables auto JS
  rendering when the verdict is `csr-shell` — the sitemap-browser class).
  The frontend server fn is `analyzeWebsite` in `src/lib/crawl.ts` (its
  `WebsiteProfile` type mirrors the crawler's, kept type-only at the API
  boundary). Verified live: `POST /api/analyze` answered 200 in 6.5s with
  the identical profile the CLI prints (marshalfitness: Shopify · store ·
  ssr(next) · sitemap-HTTP · 1310 urls).
- **Architecture:** one new module `backend/crawler/analyze.ts` (post-P6
  path — the crawler moved into the backend on Aug 10) that imports the
  existing discovery/extract functions. Probes share the same
  `HttpOptions` (politeness, throttle, proxy, robots gate), so the analyzer
  is as polite as the crawler. One surgical exception to "zero changes":
  the acceptance run exposed a real `detectPlatform` bug (see below) that
  was fixed IN the shared detector — the analyzer never special-cased it.
- **Persist + pre-fill:** store the profile on `Store.analysis`; the crawl form
  pre-fills the recommended config from it. This is where the prevention value
  lands — the analyzer *predicts*, it never replaces the crawl (a store can
  still trip a WAF mid-crawl after a clean probe).
- **Phase 3 (analyze-first crawls): ✅ shipped (Aug 9).** Clicking **Run
  crawl** now analyzes the store FIRST, then starts the crawl "of that type":
  `POST /api/crawl-jobs` runs the same five probes synchronously before
  enqueueing a manual DEEP crawl (~5–15s, `analyzing…` on the button) and
  folds the recommendation into the job's captured params:
  1. `csr-shell` rendering → forces `useBrowser: true` (recorded in
     `analysis.applied` + `renderingForced` — the panel's config-match check
     treats it as intended, not a mid-run change);
  2. `rate-limited` WAF without a proxy → applies the documented gentler
     config automatically (concurrency → 1, delay ≥ 2s);
  3. any WAF block without a proxy → a visible `warning` on the progress
     panel (the crawl proceeds — the user explicitly started it);
  4. `analyze: false` in the body opts out (instant re-crawls of known
     stores — verified: 9ms vs 6.9s); shallow quick-checks and scheduled
     runs never analyze (the scheduler enqueues directly and stays cheap).
  The snapshot rides on the job (`CrawlJob.analysis`, exposed by `publicJob`,
  never contains the proxy URL) and surfaces in the progress panel as an
  **Analyzed** strip (tier badge + platform · rendering + sitemap size +
  probe count/duration + applied notes + WAF warning) and as a tier badge on
  the Active crawls cards. Shared `TierBadge` component extracted so the
  analysis panel, progress panel and crawler list never drift. Verified live:
  marshalfitness enqueue → `sitemap-HTTP · Shopify · ssr` in 6.9s / 6 probe
  requests (identical to the standalone analyzer); `tsc`, eslint, jest 30/30
  green; code review passed.

#### Verify (acceptance) — ✅ all three passed (Aug 9)

- ✅ `node tools/analyze.mjs activefitnessstore.com` → platform **WooCommerce
  + Next** server stack, rendering **`csr-shell` (next)**, sitemap
  `productSitemap ✓` (10,505 URLs from `/om/sitemaps/en/sitemap.xml`),
  recommendation **`sitemap-browser`** — the exact answer that would have
  saved the 20-minute failed crawl. 13 requests · ~8s.
- ✅ `node tools/analyze.mjs prosportsae.com` → **`products.json: public`** —
  the analyzer discovered an **API-first path the crawl pipeline never
  tries**: prosportsae is Shopify, its `/products.json` answers 200 with
  real product JSON (verified via curl), and the recommendation is
  **`API-first`** (the one tier that can sidestep the WAF entirely — the
  HTML pages show a Cloudflare JS challenge, but the API answered). 17
  requests · ~12s. **Follow-up (P4):** the engine's discovery only probes
  WooCommerce + BigCommerce APIs — add a Shopify `products.json` probe so
  a store the analyzer flags as API-first can actually be crawled that way.
- ✅ `node tools/analyze.mjs marshalfitness.com` → platform **Shopify**
  (headless — `cdn.shopify.com` assets, `products.json` 404s with a Next
  error page), rendering `ssr (next)`, sitemap ✓, recommendation
  **`sitemap-HTTP`**. 6 requests · ~7s.

**Detection bug found + fixed by the acceptance run (Aug 9):** Shopify's
DEFAULT robots.txt lists bare `/cart` + `/checkout` disallow rules, so the
WooCommerce robots heuristic (`/checkout` && `/cart`) matched **before** the
homepage CDN check — marshalfitness.com (Shopify) read as WooCommerce, and
the analyzer skipped its Shopify API probe entirely. The discriminator is
whether the homepage carries `cdn.shopify.com` assets (it's fetched by this
point): a bare-cart/checkout robots match is now WooCommerce UNLESS the
homepage shows Shopify CDN assets, which falls through to the Shopify check.
Verified both ways: activefitness (WooCommerce, no CDN assets) still reads
WooCommerce; marshalfitness (Shopify, CDN assets) reads Shopify. The fix
lives in `discover/platform.ts` — the analyzer and the crawler share it.

### P3 — Matching & comparison (the product)
- ✅ **Unblocked (Aug 8):** matches now pair real products with real prices;
  cross-currency rows compare in USD (`priceUsd`) — OMR vs AED works
  (LiveUp Medicine Ball, Concept 2 Indoor Rower above).
- ✅ **Compare UI (Aug 9):** each match row renders **side-by-side product
  cards** — your product + price vs theirs — with the shared `StorePill`
  (ink = your store, amber = competitor), visible USD estimates, best-price
  + out-of-stock chips, and a fixed-width **grid** layout (the old
  `table-fixed` Cheapest column collapsed to 0px on narrower tables and
  overlapped the Difference column).
- Watch the remaining fuzzy/URL-slug matches (category pages still in the
  mix on both sides) and decide whether to exclude non-product slugs from
  the matcher entirely.

### P4 — Crawler robustness (lessons from this session)
| Item | Problem it solves |
|---|---|
| **Region/locale selection** | ✅ **done (Aug 10).** New optional `locale` crawl param (Sources → Configuration → **Region / locale**) filters sitemap candidates to one region: activefitness's 12 sitemaps (om/bh/qa/kw/sa × en/ar) become the 2 `om` ones, lifetimefitness's 4 country files (`sitemap_ae/sa/om/qa.xml`) become 1 — the same products in different currencies are no longer crawled 4× or mixed into one catalogue (AED + SAR + OMR). Matching handles both encodings seen in the wild — path segment (`/om/sitemaps/…`) and filename suffix (`sitemap_om.xml`) — and never filters the default `/sitemap.xml` candidates, so single-region stores are unaffected. Plumbed `CrawlRunInput.locale` → job params → worker → `CrawlConfig.locale` → `sitemapCandidates`/`fetchSitemapUrls`, with the panel's config-match check and a `region:` badge on the live progress panel; discovery logs how many other-region sitemaps were skipped. **Verified:** 11 unit sanity checks against the real robots.txt patterns (12→2, 4→1, language filter, word-boundary safety); tsc/eslint/jest 30/30 green. |
| **SEO-city landing pages** | ✅ **fixed (Aug 9).** Rank Math auto-generates category × city pages for GCC stores (`/treadmills/treadmills-in-abu-dhabi`, `…-in-al-ain`…). They're sitemap leaves with ZERO product data, so the flat leaf heuristic queued all 7,714 of them from `lifetimefitnessstore.com/sitemap_ae.xml` — and a 500-page cap crawl consumed its entire budget on them: `fetched 0 · failed 500 · products 0`, while the site itself answered 200 (no WAF!). Shared classifier now flags a URL whose LAST segment ends `-in-<city>` (UAE/KSA/OM/QA city list) as junk — real products end in SKU codes, never place names. Verified on the live sitemap: 7,744 flagged, **zero false positives** on real products (`…-nnnetl19718`, `…-f-g20-base` kept), all flagged samples confirmed no-product-data. |
| **Shopify products.json discovery (Tier 3)** | ✅ **fixed (Aug 9).** Discovery only probed WooCommerce + BigCommerce APIs — a store whose sitemap is 429-blocked crawled to zero even with a public Shopify catalogue (athletix.ae: `/sitemap.xml` 429'd, HTML BFS found nothing, 0 products — while `/products.json?limit=250` paged cleanly; the analyzer already flagged `products.json: public`). New `probeShopifyApi` + `discoverShopifyProducts` in `adapters/shopify-discover.ts` (mirrors the WooCommerce adapter: 1-request probe, then walk `page=N` until a short page, respect robots + pause/cancel + 10k cap), wired into `discover/index.ts` as Tier 2.7 gated on the analyzer's `looksShopify` rule (platform Shopify/unknown/plain OR `cdn.shopify.com` in the homepage). The fetch loop's existing per-product `/products/{handle}.json` probe then parses each URL. **Verified live: full walk returned 5,679 product URLs** (matching the 5,679-product sitemap); `analyze.mjs athletix.ae` → `products.json: public` · **API-first**. `analyze.ts` now reuses the shared probe (its private copy deleted). |
| **Tier-2 residential proxy** | ✅ **built (Aug 9).** The gateway URL flows `CrawlRunInput.proxy` → `CrawlConfig.proxy` → every HTTP request via undici's `ProxyAgent` (the field was already plumbed end-to-end). This session closed the real gaps: **(1) Playwright rendering now exits through the proxy too** (`core/browser.ts` splits the gateway URL into context-proxy shape — server without userinfo + explicit username/password, since Playwright mis-parses credentials in the server string) so a WAF can't spare the JS-shell pages; **(2) POST /api/proxy/test** (`proxyController.js` + `routes/proxy.js`) verifies a gateway BEFORE a crawl burns time on it — fetches an IP-echo THROUGH the proxy and returns the exit IP the crawl would use; **(3) a latent undici-version bug fixed**: Node's global fetch is a DIFFERENT undici copy than this package's and rejects its `ProxyAgent` with "invalid onRequestStart method" (undici 8.10.0 agent under Node 24's global fetch) — proxied requests now use undici's OWN `fetch` + its `ProxyAgent` from the same copy (proven: exit IP `182.180.56.177` through a real CONNECT tunnel); **(4) redaction + lifecycle**: proxy agents are pooled (bounded, evicted agents closed) and closed after each crawl so sockets can't leak across jobs or delay worker exit; the gateway URL (especially its credentials) is redacted from persisted failure text at THREE layers — the crawler's `sanitizeProxyFromMessage` (single source of truth in `core/http.ts`), the worker's boundary net in `sanitizeResult` (blanket-redacts failures + discovery findings/log), and the controller's error paths. **Verified live:** proxy-test endpoint positive (`ok: true · exit IP …`), negative (clean `fetch failed`, zero credential leak), and the engine's own `fetchWithRetry` through the proxy (was broken — would have failed EVERY proxied crawl). `tsc`, eslint, jest 30/30 green. **UI:** the Sources config panel's **Residential proxy** field gained a **Test proxy** button showing the exit IP. Note: athletix's *API* path still works without it — the products.json walk sidesteps the WAF entirely, like prosportsae's would. |
| **Worker code versioning** | Fixes don't reach running workers (bit us twice). Log the crawler code version on the job; treat restart as the deploy step. |
| **Failure classification** | "No product data found" currently lands in `failed` alongside HTTP errors — split extraction-miss vs blocked so a 0-priced run reads honestly. |

### P5 — Production (unchanged from `plan.md` Phase 5)
Auth on the data API · observability (job metrics + crawl logs) ·
containerized workers · CI · drop `CrawlResult` after the read-path flip.

### P6 — Crawler packaging cleanup — ✅ **done (Aug 10)**

**The wart (now fixed):** the crawler lived in `frontend/src/lib/crawler/` —
a *browser* package folder — but it only ever ran **server-side**: in the
backend worker process (`worker.mjs` imports it via Node 24
type-stripping), in backend controllers (`/api/analyze`, `/api/proxy/test`),
in the ingest pipeline (`crawlSync`), and in `tools/`. The frontend browser
bundle never shipped it (the only frontend reference was a **type-only**
import). The folder name misled, its 4 runtime deps sat in
`frontend/package.json`, and every server-side consumer reached across the
repo with awkward `../../frontend/src/lib/crawler/...` paths.

**Shipped (Aug 10):** `git mv` to **`backend/crawler/`** — everything-in-
backend, **no separate `packages/` workspace, no nested package.json** (the
user's decision). The 4 runtime deps (`undici`, `robots-parser`, `playwright`,
`better-sqlite3`) moved from `frontend/package.json` to `backend/package.json`
(same versions) + `typescript`/`@types/node`/`@types/better-sqlite3`
devDeps; new `backend/crawler/tsconfig.json` + `npm run typecheck`
(`tsc -p crawler/tsconfig.json --noEmit`) so the moved TS is checked where it
runs. All 8 importer paths rewritten (worker `../crawler/index.ts`,
controllers/services `../crawler/…`, tools `../backend/crawler/…`, and the
frontend's type-only import now crosses into `backend/crawler/analyze` —
erased at compile, zero runtime coupling). `tools/` junk scripts became
cwd-independent (`__dirname`-relative) so they work from anywhere.

**Verified:** Node 24 loads the ESM `.ts` files under backend's CommonJS
package via module-syntax detection (the probe proved deps — not module kind
— were the real blocker; the benign `MODULE_TYPELESS_PACKAGE_JSON` warning
is logged once per process, the accepted tradeoff for no nested
package.json). Worker-style import loads (`runCrawl`, `sanitizeProxyFromMessage`
✅), backend `typecheck` ✅, `jest` 30/30 ✅, frontend `tsc`+eslint ✅,
`tools/analyze.mjs` live (activefitness → sitemap-browser ✅), junk
check/purge ✅. Docs updated (this section, summary, plan, AGENTS, worker/
crawlSync comments).

#### Complete inventory (ground truth, Aug 10)

**The module — 26 files:**

```
frontend/src/lib/crawler/
├── index.ts                  (public API: runCrawl, runSitemapCrawl, closeProxyAgent, sanitizeProxyFromMessage)
├── analyze.ts                (P2 Website Intelligence Analyzer: analyzeWebsite, WebsiteProfile)
├── adapters/  (5): bigcommerce.ts, shopify.ts, shopify-discover.ts, shopify-parse.ts, woocommerce.ts
├── core/      (7): browser.ts, checkpoint.ts, control.ts, http.ts, politeness.ts, queue.ts, types.ts
├── discover/  (6): homepage.ts, html-crawl.ts, index.ts, junk-segments.ts, platform.ts, sitemap.ts
└── extract/   (6): html-heuristics.ts, jsonld.ts, mapper.ts, microdata.ts, opengraph.ts, schema.ts
```

**Every external importer (8 files):**

| # | File | Import | What it pulls |
|---|---|---|---|
| 1 | `backend/workers/worker.mjs:99` | `PARITY_CRAWLER_MODULE ?? '../../frontend/src/lib/crawler/index.ts'` (env override is the test seam) | `runCrawl`, `isCrawlCancelled`, `sanitizeProxyFromMessage` |
| 2 | `backend/controllers/analyzeController.js:24` | `'../../frontend/src/lib/crawler/analyze.ts'` (cached) | `analyzeWebsite` |
| 3 | `backend/controllers/proxyController.js:45` | `'../../frontend/src/lib/crawler/core/http.ts'` (cached) | `sanitizeProxyFromMessage` |
| 4 | `backend/services/crawlSync.js:46` | `'../../frontend/src/lib/crawler/discover/junk-segments.ts'` (cached) | `hasJunkSegment` |
| 5 | `tools/analyze.mjs:37` | `'../frontend/src/lib/crawler/analyze.ts'` | `analyzeWebsite` |
| 6 | `tools/purge-junk-all-stores.js:15` | `'../frontend/src/lib/crawler/discover/junk-segments.ts'` | `hasJunkSegment` |
| 7 | `tools/check-junk-all-stores.js:12` | `'../frontend/src/lib/crawler/discover/junk-segments.ts'` | `hasJunkSegment`, `isProductUrl` |
| 8 | `frontend/src/lib/crawl.ts:367` | `import type {…} from "@/lib/crawler/analyze"` — **type-only** (`WebsiteProfile`, `RecommendationTier`, `RenderVerdict`), erased at compile | types only, zero runtime coupling |

**Runtime npm deps the crawler actually imports (4 — all currently in
`frontend/package.json`):**

| Dep | Used by | Notes |
|---|---|---|
| `undici` | `core/http.ts` | `ProxyAgent` + its own `fetch` (the version-coupling fix) — **must stay the SAME copy as every consumer** |
| `robots-parser` | `core/politeness.ts` | robots gate |
| `playwright` | `core/browser.ts` | lazy `require` |
| `better-sqlite3` | `core/checkpoint.ts` | lazy `require`, native module |

**Scripts / entrypoints:**
- `backend/package.json` → `"worker": "node --expose-gc --max-old-space-size=3072 workers/worker.mjs"` (runs the crawler).
- `tools/analyze.mjs` — standalone CLI (node `tools/analyze.mjs <url>`).
- No root `package.json`, no npm workspaces, no monorepo tooling (frontend + backend are independent installs).

**Config that covers the crawler today:**
- `frontend/tsconfig.json` — `include: ["src/**/*.ts"…]` + `paths: { "@/*": ["./src/*"] }` (typechecks the crawler; `allowImportingTsExtensions` already on).
- `frontend/eslint.config.js` — lints `**/*.{ts,tsx}` (crawler included).
- `frontend/vite.config.ts` — `resolve.tsconfigPaths`.
- Backend has **no** tsconfig / eslint config (plain CJS JS).

**Docs referencing the path (update in the same change):** `summary.md`
(lines 21/27/193), `plan.md`, `architecture.md`, `improvement-plan.md`
(this section), `frontend/AGENTS.md`, plus inline comments in `worker.mjs`,
`crawlSync.js`, `proxyController.js`, `analyzeController.js`, `junk-segments.ts`.

#### The critical constraint (verified empirically)

Node 24's type-stripping decides module kind for a `.ts` file by the nearest
`package.json` `type` field. The crawler uses ESM `import`/`export` — it loads
**only because** `frontend/package.json` has `"type": "module"` (verified:
frontend = `module`, backend = no `type` → CommonJS). **Any new home needs a
`"type": "module"` package.json at or nearest above the moved folder**, or
`import`/`export` syntax fails at worker boot. This is the trap that makes the
move non-trivial.

#### Option A — `packages/crawler/` (recommended: the honest home)

1. `git mv frontend/src/lib/crawler packages/crawler/`
2. New `packages/crawler/package.json`: `{ "name": "@parity/crawler",
   "private": true, "type": "module", "dependencies": { undici,
   robots-parser, playwright, better-sqlite3 } }` + `npm install` inside it
   (own `node_modules`; no root workspaces needed).
3. New `packages/crawler/tsconfig.json` (mirror frontend's) so `tsc --noEmit`
   still checks it; a `typecheck:crawler` script.
4. Rewrite the 8 importer paths: worker
   `'../../../packages/crawler/index.ts'`, controllers/services
   `'../../packages/crawler/…'`, tools `'../packages/crawler/…'`, and
   `crawl.ts`'s type-only import → relative
   `'../../../packages/crawler/analyze'` (or a `@crawler/*` tsconfig path).
5. Drop the 4 deps from `frontend/package.json` (verify each is crawler-only
   first); exclude `packages/` from frontend lint/tsc.
6. Verify: `tsc` (frontend + crawler), eslint, backend `jest` 30/30, worker
   boot smoke, `tools/analyze.mjs` live, one live crawl.

**Pros:** honest module boundary; ESM works via its own `type: module`;
deps travel with the code; frontend ships/lints/typechecks nothing it never
runs. **Cons:** biggest footprint (own package.json + tsconfig + install);
no monorepo tooling today, so `packages/` is a third independent install.

#### Option B — `backend/crawler/` (lighter touch)

1. `git mv frontend/src/lib/crawler backend/crawler/`
2. New `backend/crawler/package.json` with `"type": "module"` (CRITICAL —
   backend's own package.json is CJS; without the nested one the worker dies)
   + the 4 deps in `backend/package.json` (resolution walks up to
   `backend/node_modules`).
3. Rewrite importers: worker `'../crawler/index.ts'`, controllers/services
   `'../crawler/…'`, tools `'../backend/crawler/…'`.
4. Frontend type-only import → relative `'../../../backend/crawler/analyze'`
   (frontend reaching INTO backend for a type — the awkward part).
5. Same verification battery.

**Pros:** minimal — backend is already the primary consumer; paths shrink.
**Cons:** the engine stays buried inside the API package; frontend imports a
type from backend (arguably worse than today); ESM subpackage inside a CJS
backend needs the nested package.json explained forever.

**Recommendation: Option A** — the folder's only real purpose is to be a
shared server-side module; `packages/crawler/` states that honestly and keeps
both frontend (types only) and backend (runtime) consumers on equal footing.

---

## 4. Decision rule

Priority order when anything breaks or anything new is proposed:

> **Data loss / blocked > unblocking matching > features that prevent future
> failures > polish**

- Data loss and blocked pipelines always come first (P1).
- New features must justify themselves against the north star: do they get
  real, comparable prices into the catalogue faster or more reliably?
- The mentor's study roadmap maps onto P2: each probe is a small lesson in how
  websites are built — platform, APIs, JSON-LD, rendering, anti-bot. We learn
  the material by building the tool, not by pausing the product.

*Living document — revise it as items ship.*
