<!-- LOVABLE:END -->

# Project context

## What this is

**Parity** — a competitive intelligence SaaS dashboard. It lets users track
competitors, their products, pricing, product catalogues, market insights,
alerts, reports, and data sources.

**Important:** This repo was migrated *off* Lovable and *off* Supabase. It is
now a plain TanStack Start app running entirely on local mock data. There is
**no Supabase**, **no Lovable runtime code**, and **no real backend** — do not
reintroduce them. All auth is a localStorage-backed demo.

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
| `npm run lint`      | ESLint (run this after every change; currently 0 errors, 6 pre-existing`react-refresh/only-export-components` warnings in shadcn UI components) |
| `npm run format`    | Prettier write                                                                                                                                    |
| `npx tsc --noEmit`  | Typecheck (strict mode)                                                                                                                           |

Verification loop for any change: `npx tsc --noEmit` → `npm run lint` → `npm run build`.

## Source layout (`src/`)

```
src/
├── pages/            # THE ROUTES DIRECTORY — every file/folder maps to a URL (see below)
│   ├── __root.tsx            # root layout + 404 + error boundary (the TanStack Start "App.tsx")
│   ├── sitemap[.]xml.ts      # /sitemap.xml server handler
│   ├── auth/                 # public auth pages
│   │   ├── login.tsx         # /auth/login
│   │   └── signup.tsx        # /auth/signup
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
│       └── sources/          # /sources
├── components/
│   ├── ui/                   # shadcn primitives (Radix + CVA + tailwind-merge)
│   ├── common/               # shared app components
│   └── layout/               # layout components
├── constants/
│   ├── routes.ts             # central ROUTES map (incl. ROUTES.login, ROUTES.signup)
│   └── sidebar.ts
├── data/
│   └── mock/index.ts         # ALL demo data: workspace, competitors, matchedProducts,
│                             #   priceHistory, insights, alerts, reports
├── hooks/
│   ├── useAuth.ts            # useSyncExternalStore over localStorage session
│   ├── useWorkspace.ts       # mock useWorkspace + useAnalytics (feeds dashboard/pricing/etc.)
│   └── use-mobile.tsx
├── layouts/
│   ├── AuthLayout.tsx
│   └── DashboardLayout.tsx
├── lib/
│   ├── mock-auth.ts          # mock session backend (localStorage key "parity.session")
│   ├── error-page.ts         # SSR error HTML
│   ├── error-capture.ts      # SSR error capture used by server.ts
│   └── utils.ts
├── types/                    # common.ts, competitor.ts, product.ts, report.ts
├── utils/
│   ├── formatCurrency.ts
│   └── index.ts
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

## Auth (mock — no backend)

- **`src/lib/mock-auth.ts`** — `signIn`, `signOut`, `getUser`, `MockUser`.
  Session is stored in `localStorage` under the key **`parity.session`**.
  Any email/password is accepted.
- **`src/hooks/useAuth.ts`** — `useSyncExternalStore` over the localStorage
  session so all tabs/components stay in sync.
- **Guard:** `src/pages/_authenticated/route.tsx` redirects to `/auth/login`
  when there's no session. Authenticated pages use `ssr: false` (client-side
  guard), so the SSR server still returns 200 for `/` — the redirect happens
  on the client after hydration.

## Dev server on the network

`vite.config.ts` sets `server: { host: true, port: 8080, strictPort: true }`.
With `npm run dev`, Vite prints `Local` and `Network` URLs
(e.g. `http://192.168.x.x:8080/`). The machine's LAN IP is the network URL
other devices use. If you see `Port 8080 is already in use`, kill the stale
`node.exe` process holding it (check with `netstat -ano | findstr :8080`)
before starting again.

## What we've built so far (current state)

The app is a **working frontend prototype on mock data**. Every route renders a
real page driven by `src/data/mock/index.ts` — there are no placeholder shells
left:

| Page             | Route            | What it shows today                                                                                |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| Overview         | `/`            | Stat cards + charts (price movements, catalogue growth) from`useAnalytics()`; empty states wired |
| Competitors      | `/competitors` | Competitor list with`competitors` mock data                                                      |
| Matched products | `/products`    | Searchable/filterable table over`matchedProducts` (price gap, match confidence, stock, delivery) |
| Pricing          | `/pricing`     | Price comparison + history charts from`priceHistory`                                             |
| Catalogue gaps   | `/catalogue`   | Category/brand gap tables from`categoryGaps` / `brandGaps`                                     |
| AI insights      | `/insights`    | Insight cards from`insights`                                                                     |
| Alerts           | `/alerts`      | Alert feed from`alerts`                                                                          |
| Reports          | `/reports`     | Report list from`reports`                                                                        |
| Data sources     | `/sources`     | Source/crawler status UI                                                                           |

Existing shared primitives: `PageHeader`/`DashboardLayout`/`Sidebar`
(`components/layout/`), `StatCard`/`SectionTitle` (`components/cards/`),
`EmptyState`/`LoadingState` (`components/common/`), and the shadcn set in
`components/ui/`.

## What's next (the plan)

Goal — take Parity from a static mock prototype to a **real competitive
intelligence product**. Work proceeds in layers; each layer keeps the app green
(`tsc` → `lint` → `build`).

### Layer 1 — Page polish & copy

- Harden each page's **static content**: real section copy, descriptions,
  help/empty-state text, consistent typography, responsive behavior.
- Unify page headers, breadcrumbs, and table/toolbar patterns across pages.
- Make titles/meta consistent (see "Page titles" gotcha).

### Layer 2 — Product functionality on mock data

- Add page-level interactions: filtering, sorting, pagination, drill-downs
  (e.g. product → price history, competitor → profile).
- Add global search + command palette over competitors/products/insights.
- Add create/edit flows (e.g. add a competitor, subscribe to a data source,
  configure an alert) using `react-hook-form` + `zod` (already installed).
- Move interactive state to `useWorkspace`/`useAnalytics` so pages stop reading
  `src/data/mock` directly.

### Layer 3 — Real backend (swap mock → live)

- Replace `mock-auth` (localStorage) with real auth (the app still must work
  for demo; keep a demo mode behind a flag).
- Introduce a real API layer (server functions in TanStack Start) and migrate
  each hook from mock data to fetched data.
- Add persistence + migration story for workspace/competitors/products.

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
- **Keep the demo runnable** (`npm run dev` → network URL) at every step; the
  product is currently shown to stakeholders from mock data.
- Follow the verification loop after every change and keep the routes/pages
  structure stable (file-based routing drives URLs).

## Recurring dev notes

- Prettier config includes `"endOfLine": "auto"` — do not strip it; without it
  CRLF line endings cause lint failures.
- `npm run build` produces both `dist/client` and `dist/server` — the SSR
  chunks for `router.tsx`, `start.ts`, and `server.ts` are expected in the
  server bundle.
- ESLint: the 6 `react-refresh/only-export-components` warnings come from
  shadcn `components/ui/*` and are pre-existing — do not chase them.
- This repo is connected to Lovable: never rewrite published git history
  (see the banner at the top of this file).
