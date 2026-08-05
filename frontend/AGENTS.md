<!-- LOVABLE:END -->

# Project context

## What this is

**Parity** — a competitive intelligence SaaS dashboard. It lets users track
competitors, their products, pricing, product catalogues, market insights,
alerts, reports, and data sources.

**Important:** This repo was migrated *off* Lovable and *off* Supabase. It is
now split into two apps:

- **`frontend/`** — the TanStack Start app (this directory). UI, routing,
  TanStack Query hooks, and the crawler server function.
- **`backend/`** — a separate Express + MongoDB API (port 3000) that owns
  auth (JWT) and serves the dashboard dataset over `GET /api/data/*`.

The frontend talks to the backend through a dev proxy (`/api` → `:3000`).
There is **no Supabase** and **no Lovable runtime code** — do not reintroduce
them. The old demo dataset (`backend/data/demo-data.json`) has been **deleted**
— every `/api/data/*` response is now either **derived from real saved crawls**
(the `CrawlResult` collection, written when a crawl finishes) or **honestly
empty** for features that have no data source yet. The demo admin user is
seeded into MongoDB on backend boot.

## Tech stack

- **Framework:** TanStack Start (SSR-first) — `@tanstack/react-start` ^1.168
- **Routing:** TanStack Router (file-based, generated route tree) — `@tanstack/react-router` ^1.170
- **UI:** React 19.2, Tailwind CSS v4 (`@tailwindcss/vite`), shadcn-style Radix components
- **Build tool:** Vite 8 (dev = `vite dev`, prod build = `vite build` → Nitro SSR server)
- **Data fetching:** TanStack Query 5
- **Forms:** react-hook-form + zod
- **Charts:** recharts

## Commands

| Command               | Purpose                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`       | Start dev server on**port 8080**, exposed on the network (`host: true`)                                                                   |
| `npm run build`     | Production build: client + Nitro SSR server →`dist/client`, `dist/server`                                                                    |
| `npm run build:dev` | Build with development mode                                                                                                                       |
| `npm run preview`   | Preview the production build                                                                                                                      |
| `npm run lint`      | ESLint (run this after every change; currently 0 errors, 3 pre-existing`react-refresh/only-export-components` warnings in shadcn UI components) |
| `npm run format`    | Prettier write                                                                                                                                    |
| `npx tsc --noEmit`  | Typecheck (strict mode)                                                                                                                           |
| `npm run crawl`    | CLI crawl against obdesignsusa.com, checkpointing to `.crawler/` (gitignored)                                                                  |
| `cd ../backend && npm start` | Start the Express API on :3000 (needs MongoDB running; seeds the demo admin user)                                                |

Verification loop for any change: `npx tsc --noEmit` → `npm run lint` → `npm run build`.

> **Run both servers for the full app:** `cd backend && npm start` (API on
> :3000) **and** `npm run dev` in `frontend/` (UI on :8080, proxies `/api` to
> the backend).

## Source layout (`src/`)

```
src/
├── pages/            # THE ROUTES DIRECTORY — every file/folder maps to a URL (see below)
│   ├── __root.tsx            # root layout + 404 + error boundary (the TanStack Start "App.tsx")
│   ├── sitemap[.]xml.ts      # /sitemap.xml server handler
│   ├── auth/                 # public auth pages
│   │   └── login.tsx         # /auth/login
│   └── _authenticated/       # authenticated group (guarded shell)
│       ├── route.tsx         # auth guard + DashboardLayout wrapper
│       ├── index.tsx         # /           → Overview
│       ├── competitors/      # /competitors
│       ├── products/         # /products
│       ├── pricing/          # /pricing
│       ├── catalogue/        # /catalogue
│       ├── insights/         # /insights
│       ├── alerts/           # /alerts
│       ├── reports/          # /reports
│       ├── crawls/           # /crawls   (Saved crawls history)
│       ├── stores/           # /stores/$origin (full store catalogue page)
│       └── sources/          # /sources  (Crawler)
├── components/
│   ├── ui/                   # shadcn primitives (Radix + CVA + tailwind-merge)
│   ├── common/               # shared atoms + state cards (states/StateCard, stock-badge, product-cell, price-delta)
│   ├── cards/                # StatCard/SectionTitle, CrawlStat, CrawlStatsGrid, CrawlDiffTile, CrawlDiffSummary
│   ├── crawls/               # saved-crawl UI (store-profile)
│   ├── competitors/          # add-competitor-dialog, compare-stores
│   └── layout/               # layout components
├── constants/
│   ├── index.ts              # barrel: ROUTES + sidebar nav groups (INTELLIGENCE_NAV, OPERATIONS_NAV)
│   ├── routes.ts             # central ROUTES map (incl. ROUTES.login)
│   └── sidebar.ts
├── hooks/
│   ├── useWorkspace.ts       # useWorkspace + useAnalytics (fetch from backend /api/data)
│   ├── useData.ts            # per-domain useApiQuery hooks (competitors, products, …) + useSavedCrawls (polls saved crawls every 30s)
│   ├── useLocalStorage.ts    # SSR-safe localStorage-backed useState (refresh-proof UI state: job id, crawl config, …)
│   └── use-mobile.tsx
├── layouts/
│   ├── AuthLayout.tsx
│   └── DashboardLayout.tsx
├── lib/
│   ├── http.ts               # token-aware fetch client (/api prefix + Bearer JWT)
│   ├── api.ts                # REST getters for GET /api/data/* (workspace, analytics, … + crawl-results)
│   ├── auth.ts               # real JWT auth (signIn → POST /api/auth/login; token + session in localStorage)
│   ├── crawl.ts              # startCrawl/getCrawlProgress job API (live discovery+fetch progress, params snapshot) + scheduleCrawl/getCrawlSchedules/cancelCrawlSchedule (checkpointed crawler, persisted to backend)
│   ├── error-page.ts         # SSR error HTML
│   ├── error-capture.ts      # SSR error capture used by server.ts
│   └── utils.ts
├── types/                    # common.ts (incl. DashboardStats), competitor.ts, product.ts, report.ts
├── utils/
│   ├── formatCurrency.ts
│   ├── crawls.ts             # origin/URL helpers, prefill-crawler, crawl diff, robots text
│   ├── format.ts             # formatPrice, formatDuration (shared number/formatting helpers)
│   ├── compare.ts            # cross-store comparison (exact + fuzzy name matching, threshold)
│   └── index.ts              # barrel re-export (gbp)
├── styles.css
├── router.tsx                # getRouter() factory (routeTree + QueryClient) — REQUIRED by Start
├── routeTree.gen.ts          # AUTO-GENERATED from src/pages — never hand-edit
├── server.ts                 # Nitro/edge server entry (prod build only, not used by dev)
├── start.ts                  # createStart() — server middleware (error page + CSRF)
```

Path alias: `@/*` → `./src/*` (wired via `resolve.tsconfigPaths` in vite.config.ts).

## Entry-point conventions (TanStack Start — no `app.tsx`/`main.tsx`)

TanStack Start is SSR-first; the classic Vite-SPA entry files do **not** exist
here and nothing is missing:

- **No `src/main.tsx`** — the client entry is injected automatically by the
  TanStack Start plugin (`@tanstack/react-start/client-entry`).
- **No `src/App.tsx`** — the app root layout is `src/pages/__root.tsx`.
- **`src/router.tsx`** — REQUIRED by convention. Exports `getRouter()`; the
  Start plugin and `start.ts` pick it up from this exact path.
- **`src/start.ts`** — REQUIRED entry for `createStart()`. Holds server
  middleware: custom error page + `createCsrfMiddleware` (protects server
  functions from cross-site requests). If deleted, Start auto-installs a bare
  default and you lose error handling + CSRF.
- **`src/server.ts`** — OPTIONAL (but used). The custom server entry for the
  Nitro production build (`npm run build` → `dist/server/server.js`). NOT used
  by `vite dev`. Keep it if you run/deploy the production server.
- **`src/routeTree.gen.ts`** — AUTO-GENERATED by the router plugin from
  `src/pages/` on every file change. Never edit by hand.

## Routing gotchas (do not "fix" these)

1. **Routes directory config:** `vite.config.ts` uses
   `tanstackStart({ router: { routesDirectory: "pages", generatedRouteTree: "routeTree.gen.ts" } })`.
   These paths are **relative to `src/`** — the plugin resolves them against
   `srcDirectory`. Passing absolute/`./src/pages` paths breaks the build with
   `ENOENT scandir <root>/src/routes`. Only `"pages"` / `"routeTree.gen.ts"`.
2. **`/sitemap.xml` route:** the file **must** be named `sitemap[.]xml.ts`
   (bracketed dot). This router version's `pathParamsAllowedCharacters` excludes
   `.`, so a plain `sitemap.xml.ts` becomes `/sitemap/xml`. The brackets escape
   the dot. (The file is a server handler — it has no UI component export.)
3. **Index route files:** overview is `src/pages/_authenticated/index.tsx`, not
   `src/pages/index.tsx`.
4. **Page titles:** every dashboard page must set its own real title (e.g.
   `export const Route = createFileRoute('/competitors/')()` with a
   `document.title = ...` — do not leave placeholder names like
   `CompetitorsPage`/`AlertsPage` as the title).

## Auth (real — JWT against the Express backend)

- **`src/lib/auth.ts`** — `signIn(email, password)` calls
  `POST /api/auth/login` on the backend and stores the returned JWT under
  `parity.token` and the user profile under `parity.session` (so the existing
  `getUser()` guard keeps working unchanged). `signOut()` clears both.
  `DEMO_CREDENTIALS` (`admin@clickmasters.com` / `1234`) is shown and
  pre-filled on the login page; the backend seeds that user on boot.
- **Guard:** `src/pages/_authenticated/route.tsx` redirects to `/auth/login`
  when there's no session. Authenticated pages use `ssr: false` (client-side
  guard), so the SSR server still returns 200 for `/` — the redirect happens
  on the client after hydration.
- **401 handling:** `src/lib/http.ts` clears the session and redirects to
  `/auth/login` when the backend returns 401 (expired/stale token), so a dead
  session never strands the user on ErrorState pages.

## Dev server on the network

`vite.config.ts` sets `server: { host: true, port: 8080, strictPort: true }`.
With `npm run dev`, Vite prints `Local` and `Network` URLs
(e.g. `http://192.168.x.x:8080/`). The machine's LAN IP is the network URL
other devices use. If you see `Port 8080 is already in use`, kill the stale
`node.exe` process holding it (check with `netstat -ano | findstr :8080`)
before starting again.

## What we've built so far (current state)

The app is a **working client/server prototype**: the TanStack frontend
fetches every page's data from the Express backend over HTTP (dev-proxied
`/api` → `:3000`), and auth is real JWT against MongoDB. The demo dataset has
been **removed** — `backend/controllers/dataController.js` derives every
`/api/data/*` response from the real `CrawlResult` collection (competitors
= one per crawled origin, products = flattened crawled products, aggregate
stats = computed from saved crawls) and returns honest empty arrays for
features with no data source yet (workspace, price history, gaps, insights,
alerts, reports). Pages that get empty data render a
`NoRealDataState` ("No real data yet") with a **Run a crawl** link to
`/sources` instead of fabricated numbers. Hooks fetch via TanStack Query —
no page imports local mock data. There are no placeholder shells left:

| Page             | Route            | What it shows today                                                                                |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| Overview         | `/`            | Stat cards + competitor snapshot via`useAnalytics()`; `NoRealDataState` when no crawls exist yet  |
| Competitors      | `/competitors` | **Empty-by-default slot flow**: a "Your website" picker (persisted via `GET/PUT /api/data/my-store`, used as store A everywhere) + **4 competitor slot cards** (selections persisted under `parity.competitors.slots`), each opening a searchable `StorePickerDialog` of crawled stores that excludes already-used ones. Every filled slot renders its own **ComparePanel** (your website vs that competitor): in-both / only-A / only-B / price-differs tiles, Matches / Only A / Only B tabs with a **Cheapest** column, all **paginated** (25/page). One **Fuzzy matching** toggle + **Similarity threshold** slider applies to every comparison (both persisted under `parity.competitors.*`); fuzzy matching is **on by default**. A manual **Add competitor** dialog still exists |
| Saved crawls     | `/crawls`      | Snapshot history per store via`useSavedCrawls()`: history **hidden by default** with a per-store **Show history / Hide history** toggle, "+N new / removed · price changed / no change / first snapshot" badges, expandable rows (stats, changes vs previous, discovery, first-8 products, failures), a **View all N products** link to the full **Store catalogue** page, **Re-crawl** (prefills the crawler via `prefillCrawlerOrigin`), **Delete snapshot** / **Clear history** (`DELETE /api/data/crawl-results/:id` / `/crawl-results?origin=`) |
| Store catalogue  | `/stores/$origin` | Full-page product list for one store via`useSavedCrawls()` (dynamic route keyed by **normalized origin**): newest-snapshot default with a **snapshot picker** (a stale id falls back to the newest), a crawl **stats row** + **Store profile** card + **Discovery log** (the specific per-candidate reasons behind a crawl result), and **searchable + sortable + paginated** Products tables (50 rows/page, 25/50/100 selector) in two views: a single snapshot, or **All snapshots** — the union of every product with a per-product **price sparkline** + price range + "seen in N snapshots". Empty state for never-crawled stores with a one-click **Crawl {origin}**; header has **Crawl again** (prefills the crawler), **Delete store** (clears all snapshots) and a **Saved crawls** back link; dynamic `document.title` |
| Matched products | `/products`    | **Real matching engine**: `useMatchedProducts()` pulls rows from the backend matcher (`backend/utils/matcher.js` — GTIN > SKU > URL slug > fuzzy name). Your crawled catalogue is matched against each competitor with method + confidence, a your-price / price-gap column, and competitor products you don't carry listed as **Unmatched**; searchable / filterable / paginated. Honestly empty until you set your store on `/competitors` and crawl it + competitors |
| Pricing          | `/pricing`     | **Real price history**: market/cheapest/your-store trend chart + market-relative price index + "biggest price movements" list, all derived from saved snapshots via `computePriceHistory` (same data feeds the dashboard trend). Honest "crawl again" hint when <2 snapshot events |
| Catalogue gaps   | `/catalogue`   | Charts/gaps empty until the category/brand gap analysis is built (the matching layer is live); honest`NoRealDataState`               |
| AI insights      | `/insights`    | `NoRealDataState` (needs the insight engine)                                                     |
| Alerts           | `/alerts`      | `NoRealDataState` (needs the alert engine)                                                       |
| Reports          | `/reports`     | `NoRealDataState` (needs the report generator)                                                   |
| Data sources     | `/sources`     | Domain-first **Start a crawl** card (domain + collections + run/schedule + "Recently crawled" chips) + a **Store profile** card detected from the **last saved crawl** (platform, URL pattern, sitemap, robots.txt + crawl-delay, parse %, product count) + **Live crawl** panel (live discovery diagnostics, fetch-phase ETA, "Running with" params + mid-run config warning) + **"What's new since the last crawl"** diff vs the previous snapshot + **Frequency scheduler**. Full snapshot history now lives on the separate **`/crawls`** page. Panel state is **refresh-proof**: config, running `jobId`, expanded saved-crawl row and schedules cache persist via `useLocalStorageState`, and the job id is mirrored to `?job=` so a reload (even in another tab) reconnects to the running crawl ("Reconnected to running crawl" badge) |

Existing shared primitives: `PageHeader`/`DashboardLayout`/`Sidebar`
(`components/layout/`), `StatCard`/`SectionTitle`/`CrawlStat`/`CrawlStatsGrid`/
`CrawlDiffTile`/`CrawlDiffSummary` (`components/cards/`),
`LoadingState`/`ErrorState`/`NoRealDataState`/`StateCard`/`PriceDelta`/
`StockBadge`/`ProductCell` (`components/common/`), the saved-crawl and
competitor feature components (`components/crawls/`,
`components/competitors/`), and the shadcn set in `components/ui/`. Shared
helpers live in `utils/crawls.ts` (origin/URL utils, `computeCrawlDiff`,
`robotsText`), `utils/format.ts` (`formatPrice`, `formatDuration`) and
`utils/compare.ts` (`compareStores` — exact + fuzzy name matching with a
tunable threshold).

## What's next (the plan)

Goal — take Parity from a static mock prototype to a **real competitive
intelligence product**. Work proceeds in layers; each layer keeps the app green
(`tsc` → `lint` → `build`).

### Layer 1 — Page polish & copy

- Harden each page's **static content**: real section copy, descriptions,
  help/empty-state text, consistent typography, responsive behavior.
- Unify page headers, breadcrumbs, and table/toolbar patterns across pages.
- Make titles/meta consistent (see "Page titles" gotcha).

### Layer 2 — Product functionality (on real data)

- Add page-level interactions: filtering, sorting, pagination, drill-downs
  (e.g. product → price history, competitor → profile).
  *(Done — the Store catalogue page (`/stores/$origin`) has search + column
  sorting + pagination, per-product price sparklines on the All-snapshots
  view, and the Pricing page shows the market-relative time-series; a global
  command palette remains.)*
- Add global search + command palette over competitors/products/insights.
- Add create/edit flows (e.g. add a competitor, subscribe to a data source,
  configure an alert) using `react-hook-form` + `zod` (already installed).
  *(Partly done — adding a competitor and setting your "my store" are live on
  `/competitors`; alerts / data-source flows remain.)*
- (The old `src/data/mock` layer is gone — interactions now run on the real
  backend-derived data.)

### Layer 3 — Real client/server split — **done** (split + dashboard wiring)

- **Frontend API layer** — `src/lib/api.ts` is now a REST client: every
  getter hits `GET /api/data/*` on the Express backend via `src/lib/http.ts`
  (which prefixes `/api` and attaches the JWT). The `AnalyticsData`,
  `PricingData`, `CatalogueData` shapes are unchanged from the previous
  server-function era, so hooks and pages were untouched.
- **Auth migrated** — `mock-auth.ts` replaced by `src/lib/auth.ts`; the login
  page awaits the real `POST /api/auth/login` and surfaces backend errors
  (e.g. "Invalid credentials"). The demo admin user is seeded on boot
  (`backend/seed.js`).
- **Backend** — `backend/` serves `GET /api/data/{workspace,analytics,
  competitors,matched-products,pricing,catalogue,insights,alerts,reports}`,
  plus existing JWT auth and user CRUD. `backend/index.js` mounts the routes
  and calls `ensureDemoUser()` on start. `backend/controllers/dataController.js`
  derives real responses from the `CrawlResult` collection (no demo dataset
  — `backend/data/demo-data.json` was deleted).
- **Crawler** — `startCrawl`/`getCrawlProgress` live in `src/lib/crawl.ts` as
  TanStack server functions (not proxied to Express) because the crawler is
  a Node-only TypeScript module with native deps (`better-sqlite3`).
  `startCrawl` returns a `jobId` immediately and the crawl runs in the
  background; the client polls `getCrawlProgress` for live progress (server
  functions are one-shot RPC — no SSE). Each run uses a per-origin SQLite
  checkpoint (`.crawler/crawl-<host>.db`) so unchanged products are skipped
  on re-runs and every product is saved incrementally as it is crawled;
  finished results are upserted to the backend's `CrawlResult` collection.
- **Sources page** — Live crawl panel (origin + collections, `useMutation`,
  stat cards, failures, product previews) imports `startCrawl` from
  `@/lib/crawl` and polls `getCrawlProgress` for live progress. The config
  section is fully wired to real crawl parameters: concurrency (1–8),
  request delay (0.25–2s), max pages, **Respect robots.txt** toggle (with a
  politeness warning when concurrency is raised), Product-only mode, and
  Store full snapshots. A **Frequency scheduler** section registers
  recurring crawls (`scheduleCrawl`, 1h/6h/daily/weekly) with an active-
  schedules list + cancel. Finished results are saved to the backend
  `CrawlResult` collection and the saved-crawls query cache is invalidated on
  `job.persisted`, so the **`/crawls`** page (Saved crawls history) stays
  fresh without a reload.
- **Progress-panel diagnostics** — the live-crawl panel shows **real discovery
  numbers while discovery runs** (sitemap URLs found, HTML pages visited,
  product URLs so far, collection handles via `CrawlJob.discovery`), then a
  **fetch-phase ETA** (`Discovery X · Fetch Y` split — discovery time never
  inflates the estimate, 5s warm-up floor), and a **Running with** row of
  parameter badges plus a **Config changed mid-run** warning when the panel
  config diverges from the job's captured `params`.
- **Refresh-proof Sources page** — `src/hooks/useLocalStorage.ts` (SSR-safe
  localStorage-backed `useState`; try/catch reads/writes, server no-ops)
  backs every crawl-panel control under `parity.sources.*`: origin,
  collections, **job id**, delay, concurrency, **max-pages mode with a
  Custom… free number input** (strict positive integer via `Number()` +
  `Number.isInteger`; empty falls back to unlimited), robots/product-only/
  snapshot toggles, and frequency. Also persisted: a schedules cache
  (`parity.sources.schedules`) that renders silently while the live query
  loads and shows an honest "Server unreachable — showing the last known
  schedules from memory" note only on error (`isError && !data` — live
  server response always wins, so cancelled schedules don't resurrect). A dead persisted `jobId` (pruned
  job) is cleared by an effect, and the "No progress available" hint is
  gated on `jobId != null`.
- **Cross-tab job handoff via `?job=`** — the Sources route has a typed
  `validateSearch` (`SourcesSearch { job?: string }`); on mount the URL's
  `?job=` **wins over localStorage** (mount-once ref guard), and afterwards
  `jobId` mirrors into the URL with `navigate({ search: (prev) => ({ ...prev,
  job: jobId ?? undefined }), replace: true })` — `replace: true` keeps the
  back button clean, the updater preserves other search params, and `job:
  undefined` drops the param when the job ends. A **"Reconnected to running
  crawl"** badge (with `RefreshCw` icon + helper line) renders while a
  restored job is still running: `startedInThisSession` ref records jobs this
  page session started itself (`start.onSuccess`), so a fresh run never shows
  it, and it auto-hides when the crawl finishes.
- **Detection from the last crawl** — the "Store profile" card (the
  `StoreProfile` component in `components/crawls/`) is rebuilt from the latest
  saved crawl: **platform** (detected via robots.txt markers +
  homepage signals in `discover/platform.ts`, persisted as
  `discovery.platform` with a signal tooltip), **product URL pattern**
  (derived from a real crawled product URL), **sitemap** status, **robots.txt
  presence + declared crawl-delay** (`discovery.robots`, status
  `found|absent|unreachable|skipped`), and a **parse-rate %** — with honest
  `—` fallbacks for fields the crawler doesn't capture, and a conditional
  Verified / Detected from crawl / Not connected badge. The **Discovery
  engine** card shows real per-strategy counts (sitemap URLs, HTML pages
  visited, collections) instead of the old hardcoded numbers.
- Persistence: crawl results are saved to MongoDB (backend `CrawlResult`
  model; `POST/GET /api/data/crawl-results`, `DELETE` one
  `/api/data/crawl-results/:id` or a whole store
  `/api/data/crawl-results?origin=`) plus per-origin SQLite checkpoints
  (`.crawler/crawl-<host>.db`) for skip-unchanged re-crawls and crash-safe
  incremental saves. The backend keeps **snapshot history** (up to 20 per
  origin, `createdAt`-sorted) when `storeSnapshots` is true, or replaces the
  latest result when false. **Manual competitors + your store**: a
  `Competitor` model with `POST/DELETE /api/data/competitors` and a `MyStore`
  singleton with `GET/PUT /api/data/my-store`;
  `dataController.competitors` merges crawled origins + manual entries
  (deduped by lowercase host; a manual name wins) plus a special `isMine`
  row for your own store. **Dashboard wiring is done**: the demo dataset is
  deleted and `backend/controllers/dataController.js` derives
  competitors/products/stats from the real `CrawlResult` collection,
  returning honest empty states for features with no source yet. The
  **product-matching layer is live** (`backend/utils/matcher.js`: GTIN > SKU >
  URL slug > fuzzy, wired into `/api/data/analytics`, `matched-products` and
  `pricing`) and the **price-history time-series** drives the Pricing page +
  catalogue sparklines. Still TODO: the full your-store workspace/catalogue
  import (the MyStore row stores only the origin), category/brand gaps, the
  insights/alerts/reports engines, auth for `/api/data` routes, and
  production `vite preview` needs a reverse proxy in front of the backend
  (the `/api` proxy is dev-only).

### Layer 4 — Data ingestion & alerts

- Real data-source connectors (web crawlers/APIs) feeding competitors,
  products, and prices.
- Alert engine: detect price drops, catalogue gaps, stock changes → alert feed.
- Insight generation from collected data.

### Layer 5 — Productionize

- Error handling, loading/skeleton states, and analytics instrumentation.
- Automated tests (component + e2e).
- Deployment: build via Nitro (`dist/server`), configure host, CI pipeline.

## Decision rules / constraints

- **Never reintroduce Supabase or Lovable runtime code.** Mock-first, then a
  clean API layer on top — do not bolt on a third-party BaaS.
- **Keep the app runnable** (`npm run dev` → network URL) at every step. The
  demo dataset is gone — pages must never show fabricated numbers; anything
  without a real source renders `NoRealDataState` instead.
- Follow the verification loop after every change and keep the routes/pages
  structure stable (file-based routing drives URLs).

## Recurring dev notes

- Prettier config includes `"endOfLine": "auto"` — do not strip it; without it
  CRLF line endings cause lint failures.
- `npm run build` produces both `dist/client` and `dist/server` — the SSR
  chunks for `router.tsx`, `start.ts`, and `server.ts` are expected in the
  server bundle.
- ESLint: the remaining `react-refresh/only-export-components` warnings come
  from shadcn `components/ui/*` and are pre-existing — do not chase them.
- This repo is connected to Lovable: never rewrite published git history
  (see the banner at the top of this file).

---

# Crawler — generic e-commerce crawler

The crawler started Shopify-only (hardcoded `/products/{handle}.json`), but
build steps 1–5 below are done: it is now a **generic engine** with a Shopify
native adapter, JSON-LD/microdata/OG/HTML extraction, sitemap + HTML-crawl
discovery, SQLite checkpointing, and robots.txt + adaptive-throttle
politeness. Parity's stated goal (Layer 4 of the product plan) is "real
data-source connectors (web crawlers/APIs) feeding competitors, products, and
prices" — the Playwright fallback, the WooCommerce + BigCommerce adapters,
cross-store identity matching (build step 8) and residential proxy routing
(Tier 2) are **done**; remaining work (enterprise adapters for Nike/Zara) is
tracked in "Current state" below.

This section is the working plan for evolving the crawler into a generic
e-com crawler. It records the design analysis, the build order, and the
current state of the work so anyone (human or agent) can pick it up.

## What we have today (state at start of plan)

- `src/lib/crawler/http.ts` — `fetchWithRetry`, `fetchText`, `fetchJson`,
  `parseRetryAfter`, `httpOptions`. Global `fetch`, configurable delay + retries
  + UA. Exponential backoff honoring `Retry-After`.
- `src/lib/crawler/discover.ts` — `fetchSitemapUrls` (sitemap + sitemapindex,
  depth ≤ 3), `extractLocs`, `discoverCollectionHandles` (Shopify collection
  page pagination, extracts `/products/{handle}`). *(Removed in a later
  cleanup — the refactor moved this into `discover/sitemap.ts` and
  `adapters/shopify-discover.ts`.)*
- `src/lib/crawler/parse.ts` — `parseShopifyProduct`, `RawProduct`,
  `RawVariant`. Only knows the Shopify `{ product: { ... } }` envelope.
  *(Removed in a later cleanup — lives in `adapters/shopify-parse.ts`.)*
- `src/lib/crawler/normalize.ts` — `toMatchedProduct`, `stockStatus`. Bridge
  from `CrawledProduct` to app `MatchedProduct`. *(Removed in a later
  cleanup — the CrawledProduct-based engine never imported it; the API
  layer maps between the two shapes.)*
- `src/lib/crawler/types.ts` — `CrawledProduct`, `CrawledVariant`,
  `CrawlConfig`, `CrawlStats`, `CrawlResult`, `CrawlFailure`.
- `src/lib/crawler/index.ts` — `runCrawl` (collection-scoped) and
  `runSitemapCrawl` (full catalogue via sitemap). Sequential per-product
  fetches, no persistence, no dedupe, no concurrency control.
- `scripts/crawl-obdesigns.ts` — thin wrapper that calls `runCrawl` for the
  OB Designs store and writes JSON.

**Strengths to preserve:** dependency-free, runs under plain `node` (Node
≥22.6 type-stripping), vendor-neutral `CrawledProduct` shape, polite
defaults, idempotent handle dedup within a run.

**Gaps (why we can't ship this as-is):** Shopify-only, no fallback for
non-Shopify stores, no platform detection, no HTML parsing, no
robots.txt/adaptive politeness, no concurrency, no persistence, no
cross-store identity, no browser fallback for JS-rendered sites.

## Design analysis

### Tiered extraction model

Real-world e-com stores need a fallback chain. No single strategy covers all
of them. The model:

| Tier | Source | Coverage | Cost |
|------|--------|----------|------|
| 1. Platform native API | `/products/{handle}.json` (Shopify), `/wp-json/wc/v3/products` (Woo), `/api/storefront/catalog/products` (BigCommerce) | High fidelity, structured | Per-platform quirks |
| 2. Sitemap + structured data | `/sitemap.xml` → product pages → parse JSON-LD `Product` schema in `<script type="application/ld+json">` | ~40–60% of all stores | Free, reliable |
| 3. HTML scraping | Cheerio + heuristic product-page detector (price near title, add-to-cart button) | ~70% of remaining | Brittle, needs tuning |
| 4. Headless browser | Playwright/Chromium for JS-rendered pages, infinite scroll, anti-bot JS | Last ~10–15% | Heavy, slow, can be blocked |
| 5. Third-party (paid) | Rainforest API, Oxylabs, Diffbot, Apify stores | Any URL | $$ per request |

**v1 target:** Tiers 1–3 cover ~85% of SMB e-com. Tier 4 is the escape hatch.
Tier 5 is a per-customer conversation.

### The key insight: JSON-LD is the universal interface

Most e-com sites embed **Schema.org `Product`** as
`<script type="application/ld+json">`. Google requires it for product rich
results, so adoption is high. Schema gives us `name`, `description`, `image`,
`brand.name`, `sku`, `gtin13`, `mpn`, `offers.{price, priceCurrency,
availability, url}`, `aggregateRating.{ratingValue, reviewCount}`.

**One JSON-LD parser covers most sites regardless of platform.** That's the
Tier 2 backbone. Fall back to: OpenGraph (`og:price:amount`,
`product:price:currency`) → Microdata → HTML heuristics.

### Discovery: not every site has a sitemap

Run in parallel, union the results:
1. **Sitemap walk** — fast, complete when present (Shopify, BigCommerce, most
   serious stores). Already implemented.
2. **HTML link crawl** — BFS from homepage, follow category links
   (heuristic: `/category/`, `/c/`, `/collection/`, `/shop/`), BFS to depth
   3, collect product-like URLs (`/product/...`, `/p/...`, `/dp/...`,
   `/item/...`). Stop on max-page cap or no new URLs.

### Engine responsibilities (same for every site)

- **Politeness** — fetch `/robots.txt` once per host, respect `Disallow` +
  `Crawl-delay`. Per-host adaptive throttle: slow down on 429, speed up after
  warmup.
- **Concurrency** — max 2 concurrent per host by default, configurable.
- **Retries** — extend current logic with distinct backoff for 403 vs 429
  vs 5xx.
- **Checkpointing** — SQLite (`better-sqlite3`, sync, single file, zero ops).
  One row per `(origin, url)` with status, last-fetched-at, etag, lastmod,
  product JSON. Resume on crash, skip unchanged (etag/lastmod match).
- **Identity dedupe** — same product across sites and across re-crawls of
  the same site. Priority: GTIN > SKU > URL slug > fuzzy name+brand.
- **Stats** — discovered, fetched, parsed, failed, skipped-unchanged,
  duration.

### Platform detection (cheap, one round trip)

```ts
async function detectPlatform(origin: string): Promise<Platform> {
  const probes = await Promise.all([
    probe(`${origin}/products/random-handle-xyz.json`),  // Shopify
    probe(`${origin}/wp-json/`),                        // WordPress
    probe(`${origin}/api/storefront/products`),         // BigCommerce
    probe(`${origin}/cart.js`),                         // Shopify cart
    probe(`${origin}/`),                                // meta tags, headers
  ]);
  if (probes.shopifyJson) return "shopify";
  if (probes.wpJson) return "wordpress";
  if (probes.bigcommerce) return "bigcommerce";
  return "generic";
}
```

Signals: response status, `X-ShopId` header, `Content-Type`, body markers
(`"shopify"`, `"woocommerce"`, `"bigcommerce"`), `<meta name="generator">`.

### Generic HTML parser (Tier 3)

Heuristics for a product page when JSON-LD is absent:
1. **Title** — `<h1>`, or `<meta property="og:title">`.
2. **Price** — schema.org `Product` first; else regex `[$€£¥]\s?\d+([.,]\d{2})?`
   near a `<span>`/`<div>` with class containing "price".
3. **Image** — `<meta property="og:image">`; else first `<img>` in a
   "gallery" container.
4. **Stock** — "Add to Cart" vs "Out of Stock" button text; schema
   `availability`.
5. **SKU/GTIN** — table rows labeled "SKU", "EAN", "GTIN", "Barcode".
6. **Category** — breadcrumb last node.

Brittle by nature — every site is different. JSON-LD first, HTML heuristics
only as last resort.

### Headless browser (Tier 4)

Only when HTTP returns empty/JS-rendered HTML. `playwright` is the right pick
(vs Puppeteer — better auto-wait, multi-browser, more actively maintained).
**Don't install Chromium by default.** Lazy-load the headless path; require
`PLAYWRIGHT_BROWSERS_PATH` env var. Most crawls won't need it.

### Library choices

- **HTTP** — keep global `fetch`. Works in Node, edge, browser. No
  `axios`/`got` needed.
- **HTML parsing** — `cheerio` (jQuery-like, fast, zero deps). `linkedom` if
  we need to keep `jsdom`-free.
- **Headless** — `playwright`. Lazy-loaded, optional peer dep.
- **SQLite** — `better-sqlite3`. Sync, fast, single file, no server. Install
  only when checkpointing ships.
- **Fuzzy match** — `fast-fuzzy` or `fuse.js`. Used in dedupe layer.
- **Robots.txt** — `robots-parser` (small, sync).

**What NOT to add:** Scrapy (Python — wrong stack), Apify SDK (lock-in),
Puppeteer (Playwright supersedes).

## Target architecture

```
src/lib/crawler/
├── core/                      # engine — same for every site
│   ├── queue.ts               # bounded concurrency per host
│   ├── politeness.ts          # robots.txt + per-host adaptive throttle
│   ├── fetcher.ts             # HTTP + optional Playwright fallback
│   ├── checkpoint.ts          # SQLite-backed resume + per-product writes
│   └── dedupe.ts              # identity (GTIN > SKU > slug > fuzzy)
├── extract/
│   ├── jsonld.ts              # Schema.org Product from <script>
│   ├── microdata.ts           # itemtype="Product"
│   ├── opengraph.ts           # og:price, product:price:amount
│   ├── html-heuristics.ts     # last resort: regex for $XX.XX, add-to-cart
│   └── schema.ts              # vendor-neutral Product shape
├── discover/
│   ├── sitemap.ts             # sitemap + sitemapindex walker
│   ├── html-crawl.ts          # BFS from homepage, follow category links
│   └── shopify.ts             # /products/{handle}.json discovery
├── adapters/
│   ├── shopify.ts             # Tier 1
│   ├── woocommerce.ts         # Tier 1 (when /wp-json is exposed)
│   ├── bigcommerce.ts         # Tier 1
│   └── index.ts               # registry + auto-pick
├── detect.ts                  # sniff platform from headers + probes
├── headless.ts                # Playwright wrapper, lazy-loaded
├── types.ts
└── index.ts                   # public API: runCrawl({ origin })
```

## Build order (8 steps, sequential, each verifiable)

Each step keeps the app green: `tsc --noEmit` → `lint` → `build`. After each
step, pause and confirm before moving on.

1. **Refactor** current code into `core/` + `adapters/shopify.ts` — zero
   behavior change. Public API unchanged. Validates the new structure
   without changing output.
2. **Add JSON-LD extractor** — biggest coverage win, ~200 LOC, no deps. One
   parser, most sites.
3. **Add sitemap + HTML-crawl dual discovery** — covers stores without
   sitemaps. Run in parallel, union, dedupe.
4. **Add SQLite checkpoint + resume + etag/lastmod skip** — turns a 2h run
   into resumable increments. Per-product atomic writes.
5. **Add concurrency + robots.txt + adaptive throttle** — production
   politeness. Per-host bounded concurrency, slowdown on 429, speedup on
   warmup.
6. **Add Playwright fallback** — escape hatch for JS-rendered stores.
   Lazy-loaded, optional peer dep.
7. **Add WooCommerce + BigCommerce adapters + auto-detect** — three named
   adapters covers majority of SMB e-com.
8. **Add identity dedupe** — match products across stores. GTIN > SKU >
   slug > fuzzy.

## Current state

- Step 1 (refactor) — **done**. Files split into `core/` (`http`, `types`),
  `discover/sitemap.ts`, `adapters/shopify-parse.ts`,
  `adapters/shopify-discover.ts`, `adapters/shopify.ts` (barrel). `index.ts`
  engine rewired. `tsc` + `lint` + `build` all green. (The back-compat shims
  `discover.ts`/`parse.ts` were removed in a later cleanup — nothing
  imported them.)
- Step 2 (JSON-LD extractor) — **done**. `extract/jsonld.ts` (handles
  `@graph`/`mainEntity`/nested nodes, `gtin13/12/8`, `AggregateOffer`),
  `extract/microdata.ts` (stub), `extract/opengraph.ts` (price + image +
  availability), `extract/html-heuristics.ts` (last-resort regex),
  `extract/schema.ts` (`ExtractedProduct` shape),
  `extract/mapper.ts` (`extractFromHtml` chain → `CrawledProduct`).
  `tsc` + `lint` + `build` all green.
- Step 3 (sitemap + HTML-crawl dual discovery) — **done**.
  `discover/html-crawl.ts` (BFS from root, follow category links, collect
  product URLs, max-pages/max-depth caps, same-origin only).
  `discover/index.ts` (`discoverProducts()` unifies collection walks +
  sitemap + html-crawl, dedupes, captures diagnostics).
  `index.ts` engine now `discover → fetch (Shopify JSON → HTML extract
  fallback) → parse`. Per-product lastmod captured from sitemap.
  `tsc` + `lint` + `build` all green.
- Step 4 (SQLite checkpoint + resume) — **done**.
  `core/checkpoint.ts` (`better-sqlite3` loaded via `createRequire`, WAL,
  one row per `(origin, url)`: etag, lastmod, status, product_json).
  Engine wires it in when `config.checkpointPath` is set: captures
  etag/lastmod from responses, `shouldFetch` fast-path reuses cached
  products when the sitemap lastmod is unchanged (counted in
  `stats.skippedUnchanged`), failures are recorded and retried next run,
  and crash-resume skips URLs whose sitemap lastmod is unchanged (URLs
  without a lastmod signal are always refetched). Transient failures
  don't destroy the cached product. `npm run crawl` checkpoints to
  `.crawler/` (gitignored). Verified with `tsc`/`lint`/`build`. Note: a
  full live crawl against obdesignsusa.com is currently blocked by the site
  rate-limiting this machine (HTTP 429); `fetchWithRetry` now has a 30s
  per-request timeout so a stalled connection can't hang a crawl.
- Step 5 (concurrency + robots.txt + adaptive throttle) — **done**.
  `core/politeness.ts` (robots-parser; `parseRobotsTxt`, `AdaptiveThrottle`
  — 429 raises the delay honoring Retry-After, successes decay it back to
  baseline, baseline = max(delayMs, robots Crawl-delay); `Politeness` facade
  loads robots.txt once, degrades to permissive on 429/unreachable).
  `core/queue.ts` (`Semaphore`, per-host `HostLimiter`, `runWithConcurrency`).
  HTTP layer waits on the throttle and reports 429/success to it; discovery
  (html-crawl, Shopify collection walk, sitemap URL filter) respects
  robots.txt via `HttpOptions.isAllowed`. Engine fetch loop now runs with
  bounded per-host concurrency (`maxConcurrencyPerHost`, default 2) and
  closes the checkpoint store via try/finally. New dep: `robots-parser`.
  Tradeoff (documented in code): the throttle's wait is per-caller, not a
  global rate limiter, so crawl-delay is a per-request baseline; the 429
  backstop is the real enforcement. Also fixed: a crawler-wide prettier pass
  removed long-hidden formatting errors in `extract/*` and `parse.ts` from
  steps 2–3 — the earlier "lint green" checks used a grep pattern that never
  matched eslint's Windows backslash paths. Verified with `tsc` + lint +
  build.- Step 5.5 (discovery diagnostics + platform + robots capture) — **done**.
  `discover/platform.ts` (`detectPlatform`: robots.txt markers → generator meta
  → asset fingerprints, never throws, degrades to "Unknown" + signal);
  **extended (verbose site intelligence)** — detection now also reports the
  platform **kind** (store / corporate site / unknown), CMS (e.g. WordPress),
  page-builder (Elementor), SEO plugin (Rank Math) and server stack from
  response headers (e.g. Apache · PHP 8.2.33); a bare `mage/` substring no
  longer false-positives as Magento (must be `/static/version` or literal
  "magento"). `discover/homepage.ts` (`analyzeHomepage`) classifies the
  homepage as store vs corporate from its product/category links and detects
  out-links to other store hosts (e.g. a `shop.` subdomain). Sitemap discovery
  (`discover/sitemap.ts`) is **multi-candidate**: robots.txt `Sitemap:`
  directives first, then `/sitemap.xml`, then `/sitemap_index.xml` — an HTML
  response (sitemap redirecting to the homepage) is detected and skipped, and
  index walks skip non-product children (images/media/news). Every run emits a
  **verbose discovery log** + **findings/suggestions** (e.g. "this looks like a
  corporate site — crawl its linked store instead") surfaced live in the
  Sources progress panel and the Store profile card; all persisted through
  `CrawlRunResult.discovery` → backend `CrawlResult.discovery`.
  `Politeness` now exposes the robots.txt fetch outcome (`robotsStatus`:
  `found|absent|unreachable|skipped`) and the declared `robotsCrawlDelayMs`;
  the snapshot flows into `DiscoveryDiagnostics.robots` (plus `platform`),
  through `CrawlRunResult.discovery`, the backend `CrawlResult` schema
  (enum-validated), and `SavedCrawl.discovery` (optional so old crawls
  don't crash). The Sources "Store profile" card surfaces both with tooltips
  and honest `—` fallbacks. Verified with `tsc` + lint + backend schema
  round-trip. *(The Sources card is now titled "Store profile".)*
- Step 5.6 (discovery & extraction hardening) — **done**. WordPress core
  sitemap **indexes** (`wp-sitemap.xml`) now resolve to their product post-type
  files (`wp-sitemap-posts-product-*.xml`); entries from a *known product
  sitemap* are trusted wholesale (`isProductSitemap` → `productOnly`), covering
  WooCommerce `/shop/<cat>/<product>/` permalinks that no URL pattern can
  classify — but only when **every** retained index child is a product sitemap
  (mixed indexes like Rank Math's `sitemap_index.xml` fall back to pattern
  filtering so pages don't leak in). Default sitemap candidates strip a
  trailing `/` from the origin (no more `//sitemap.xml`). HTML crawl follows
  `/product-category/` + `?product_cat=` and multi-segment `/shop/…` product
  links. JSON-LD extraction reads the WooCommerce/Yoast **`priceSpecification`**
  (`UnitPriceSpecification`) shape, normalizes thousands separators, and skips
  unparseable offers instead of saving fake `0`s (real zero prices are kept).
  Verified live: `atonline.com.pk` 0 → 120 products; fitnessdepot.pk prices
  extract (1400/300/4900 PKR vs all-0 before). `tsc`/`lint`/`build` clean.
- Step 5.7 (flat `<category>/<slug>` sitemap taxonomies) — **done**.
  `discover/index.ts` `filterProductSitemapEntries` (exported for tests) now
  treats a sitemap URL as a product when it is a **leaf** of the sitemap
  tree (no URL nests under it), sits at depth ≥ 2 under a standalone
  section page, and that section isn't a known non-product/archive base
  (`blog`, `news`, `shop`, `product-category`, `tag`, legal/account…).
  Unlocks tree-taxonomy stores: verified live `techmen.com.pk` went
  **0 → ~1,900 product URLs** (~96% precision on spread-sampled
  extraction; JSON-LD gives PKR price + SKU; the residual tail is
  subcategory landing pages that happen to be sitemap leaves). `tsc`/`lint`/
  `build` clean.
- Step 6 (Playwright browser fallback) — **done**. `core/browser.ts`
  (lazy Playwright renderer preferring system Chrome → Edge → bundled
  Chromium, hard timeout-guarded) wired through `core/http.ts`
  (`renderWithBrowser` re-renders pages whose server HTML looks like a
  JS shell — `#__nuxt`/`#__next`/`#root` + JS bundle, or a nearly-empty
  page), the engine (`index.ts` closes the shared browser on finish), and
  the Sources page toggle (`useBrowser` param flows through
  `CrawlRunInput` → job → schedule). Verified with a local Nuxt-style
  fixture: shell → rendered DOM → `discoverByHtmlCrawl` found the injected
  product links → `extractFromHtml` parsed a JSON-LD product (name, price,
  stock).
- Step 7 (WooCommerce native REST adapter) — **done**.
  `adapters/woocommerce.ts`: a one-request probe of `/wp-json/wc/v3/products`
  (`public | auth-required | unavailable`), a paginated catalogue walk
  (`per_page=100`, `X-WP-Total`/`X-WP-TotalPages`) feeding discovery URLs,
  a per-slug JSON fetch used by the fetch loop when the API is public, and
  `parseWooCommerceProduct` (SKU, `global_unique_id`/GTIN/barcode meta,
  regular-vs-sale price → compare-at, stock status). Discovery probes for
  WooCommerce/WordPress stores and records `discovery.wooCommerce`
  diagnostics + findings; an auth-required API (the common case — consumer
  keys) is reported honestly and the crawl continues via sitemap/HTML.
  Backend `CrawlResult.discovery.wooCommerce` added. Verified with `tsc` +
  lint + build.
- Step 7.5 (BigCommerce Storefront API adapter) — **done**.
  `adapters/bigcommerce.ts`: a one-request probe of
  `/api/storefront/catalog/products` (`public | auth-required | unavailable`),
  a paginated catalogue walk (`limit=250`, `pagination.total` /
  `pagination.total_pages`) feeding discovery URLs plus a URL → id map, a
  per-product JSON fetch **by id** used by the fetch loop when the API is
  public, and `parseBigCommerceProduct` (SKU, `calculated_price` vs `price`
  → compare-at, `availability`, `custom_url`, `brand`). Discovery probes
  BigCommerce-detected stores (generator meta / `cdn\d+.bigcommerce.com`)
  and records `discovery.bigCommerce` diagnostics + findings; an
  unavailable/auth-gated API is reported honestly and the crawl continues
  via sitemap/HTML. Backend `CrawlResult.discovery.bigCommerce` added.
  Verified with `tsc` + lint + build.
- Step 8 (identity dedupe / product matching) — **done**.
  `backend/utils/matcher.js` (`matchCatalogues(mine, theirs)`) matches your
  catalogue against one competitor's in priority order: **GTIN** (digits-only,
  ≥ 8 chars) > **SKU** (alphanumeric lowercase) > **URL slug** (last path
  segment) > **fuzzy name** (token Jaccard + containment + edit distance, 0.8
  threshold, length-bucketed scan). Every product matches at most once;
  matches carry `method` + `confidence` (100 for exact tiers, similarity % for
  fuzzy). The crawler persists `sku`/`gtin` on every product (`CrawlResult`
  schema + `crawl.ts` save path) so identity survives the crawl → Mongo
  boundary, and `dataController` wires the matcher into `/api/data/analytics`,
  `matched-products` and `pricing`: matched rows with price gap, unmatched
  competitor rows, `matchRate` / `onlyYouSell` / `onlyTheySell` /
  `avgPriceGap`, and market stats decoupled from your catalogue. Honest empty
  results until a my-store is set and crawled. Fixture test
  `backend/utils/matcher.test.js` (11 checks green) + endpoints
  curl-verified end-to-end (GTIN/SKU/slug/fuzzy/unmatched rows).
- Tier 2 (residential/rotating proxies) — **done** (`core/http.ts` +
  Sources **Residential proxy** field). An opt-in proxy gateway URL flows
  `CrawlRunInput.proxy` → `CrawlConfig.proxy` → `httpOptions.proxy`, and
  `fetchWithRetry` routes every HTTP request (robots.txt fetch included)
  through a cached undici `ProxyAgent` (`dispatcher`) — provider-side IP
  rotation fixes the reputation 403s on dawlance/techmen/teslalaptops.
  Politeness, retries/backoff and the robots gate are unchanged (the proxy
  just changes the egress IP per request); Playwright-rendered pages use
  Chromium's own network stack and are not proxied.
  The URL is server-memory / browser-localStorage only: it is never written
  to crawl results or logs, job params carry a boolean for the "Running
  with" badge, and scheduled crawls keep the URL on the server (`CrawlSchedule
  .proxyUrl`, stripped from every response). Browser fingerprinting/stealth
  is a separate concern (zara's Akamai still needs real-browser +
  residential combined).

  After that, only **Tier 4 (commercial platform, e.g. Apify)** remains —
  see `plan.md` §6.

---

# Layer 3 — frontend ↔ backend bridge (done part)

Milestone status: the frontend and backend are now wired together for real —
the TanStack app fetches data from the Express API and authenticates with JWT.

- **`src/lib/http.ts`** — token-aware fetch client: prefixes `/api`, attaches
  `Authorization: Bearer <token>` from localStorage, throws `ApiError` with
  the backend's `message`, and redirects to `/auth/login` on 401.
- **`src/lib/api.ts`** — REST getters for `GET /api/data/*` (workspace,
  analytics bundle, competitors, matched products, pricing, catalogue,
  insights, alerts, reports, crawl-results). Shapes match the backend
  `dataController`.
- **`src/lib/auth.ts`** — `signIn` → `POST /api/auth/login`; JWT in
  `parity.token`, profile in `parity.session`; `getUser()`/guard unchanged.
- **`src/lib/crawl.ts`** — `startCrawl` (POST → `{ jobId }`, runs the crawl
  in the background) + `getCrawlProgress` (POST → job snapshot with live
  `total`/`processed` counters). Node-only crawler, not proxied to Express.
  SSRF guard on origin, sanitized stats/failures/first-100 products, errors
  caught into the job's `error`. Writes per-origin SQLite checkpoints during
  the run and posts the finished result to `POST /api/data/crawl-results`
  on the Express backend (best-effort; `job.persisted` reflects success).
  Crawl parameters (`delayMs`, `maxConcurrencyPerHost`, `maxPages`,
  `respectRobotsTxt`, `productOnly`, `storeSnapshots`) flow from the Sources
  page config through `CrawlRunInput` into `runCrawl` (clamped server-side);
  `CrawlJob.params` snapshots what a job started with. The engine enforces
  `maxPages` as a fetch-loop cap (discovery count is unchanged), only applies
  the robots.txt gate/crawl-delay when `respectRobotsTxt` is true (the
  adaptive throttle always runs), and filters sitemap entries to product
  pages unless `productOnly` is false.
- **Recurring crawls** — `scheduleCrawl`/`getCrawlSchedules`/
  `cancelCrawlSchedule` register in-memory schedules (1h/6h/daily/weekly); a
  lazy 30s interval started from a handler kicks off due crawls as normal
  background jobs. Schedules reset on server restart (no persistence).
- **Hooks** — `useWorkspace`/`useAnalytics` and `useData.ts` (thin
  `useApiQuery` wrapper, plus `useSavedCrawls` which polls every 30s) all
  return `{ data, isLoading, isError }`; every page guards
  `isError` → `ErrorState` → `LoadingState`, and renders `NoRealDataState`
  when the payload is empty.
- **Backend** — `backend/` Express app: JWT auth (`/api/auth`), user CRUD
  (`/api/users`), dataset endpoints (`/api/data`), demo-user seed on boot.
  Data source: the real `CrawlResult` collection (demo dataset deleted;
  `dataController.js` derives competitors/products/stats from saved crawls
  and returns honest empty states for unconnected features).
  `POST/GET /api/data/crawl-results` persists/reads saved crawls
  (`crawlController.js`): snapshot history (cap 20/origin) when
  `storeSnapshots`, else replace-latest; `DELETE /api/data/crawl-results/:id`
  and `DELETE /api/data/crawl-results?origin=` remove one snapshot or a
  store's whole history. **Competitors**: `Competitor` model +
  `competitorController` (`POST/DELETE /api/data/competitors`), merged with
  crawled origins and the `MyStore` singleton row (`GET/PUT /api/data/my-store`)
  in `dataController.competitors`.
- Verification: `tsc` clean · `eslint src` 0 errors (3 pre-existing shadcn
  `react-refresh` warnings) · `build` clean · backend boots and serves
  `/health`, `/api/data/*`, and `/api/auth/login` (curl-verified).

Note: live crawls from the UI hit the same external rate-limits as the CLI
(obdesignsusa.com 429s this machine's IP) — the panel reports 0 products with
the failures listed, which is honest behavior rather than a bug.
