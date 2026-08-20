/**
 * Crawler pipeline: discover → fetch → parse → result.
 *
 * Usage (Node script):
 *   const result = await runCrawl({ origin, collections: ["silicone-toys"] });
 *
 * The pipeline is deliberately small and dependency-free so it runs under
 * plain Node (type-stripping) today and can be re-hosted as a TanStack Start
 * server function later.
 *
 * Post-refactor (step 1 of the generic-crawler plan): the Shopify-specific
 * bits live under `adapters/shopify.ts`; the universal sitemap discovery
 * lives under `discover/sitemap.ts`. This file is the engine.
 *
 * Per-product strategy:
 *   - Try Shopify's /products/{handle}.json first (Tier 1).
 *   - Fall back to fetching the page HTML and running the extractor chain
 *     (JSON-LD → microdata → OpenGraph → HTML heuristics).
 *
 * Checkpointing (step 4): when `config.checkpointPath` is set, each URL's
 * status, etag/lastmod and product JSON are persisted to SQLite. Re-runs
 * skip URLs whose sitemap lastmod is unchanged and reuse the cached product
 * (counted in `stats.skippedUnchanged`). Reused products keep their
 * original `crawledAt` — they weren't re-crawled this run. URLs without a
 * lastmod signal are always refetched; failed URLs are always retried.
 *
 * Politeness (step 5): robots.txt is fetched once per origin and respected
 * during discovery + the fetch loop; every request waits on an adaptive
 * per-host throttle (slows down on 429, speeds up after warmup); the fetch
 * loop runs with bounded per-host concurrency (`maxConcurrencyPerHost`,
 * default 2).
 */

import { discoverProducts } from "./discover/index.ts";
import {
  fetchStorefrontPrices,
  fetchStorefrontProduct,
  indexStorefrontProducts,
  type StorefrontPrice,
  type StorefrontUrlInfo,
} from "./adapters/storefront.ts";
import {
  closeProxyAgent,
  fetchHtmlWithStatus,
  fetchWithRetry,
  httpOptions,
  resolveUserAgent,
  sanitizeProxyFromMessage,
  type ConditionalRequest,
} from "./core/http.ts";
import { closeBrowser, renderWithBrowser } from "./core/browser.ts";
import { fetchBigCommerceProductById } from "./adapters/bigcommerce.ts";
import { parseShopifyProduct, type RawProduct } from "./adapters/shopify.ts";
import { fetchWooCommerceProductBySlug } from "./adapters/woocommerce.ts";
import { extractFromHtml } from "./extract/mapper.ts";
import { analyzeHomepage } from "./discover/homepage.ts";
import { openCheckpointStore } from "./core/checkpoint.ts";
import { isCrawlCancelled, waitForControl } from "./core/control.ts";
// Re-exported for the worker process: it imports `{ runCrawl, isCrawlCancelled }`
// from this module so a user-cancelled crawl is marked cancelled (not failed).
export { isCrawlCancelled } from "./core/control.ts";
// Tier 2 proxy lifecycle + error redaction — shared with the worker so the
// agent is closed after a crawl and the gateway URL never leaks into persisted
// failure text (single source of truth).
export { closeProxyAgent, sanitizeProxyFromMessage };
import { Politeness } from "./core/politeness.ts";
import {
  DEFAULT_MAX_PER_HOST,
  HostLimiter,
  hostOf,
  runWithConcurrency,
} from "./core/queue.ts";
import type {
  CrawlConfig,
  CrawledProduct,
  CrawlFailure,
  CrawlResult,
  RobotsInfo,
  RobotsSnapshot,
} from "./core/types.ts";

/** Product payload as returned by a Shopify /products/{handle}.json call. */
interface ShopifyProductEnvelope {
  product?: RawProduct;
}

/** Result of fetching + parsing a single product URL. */
interface FetchedProduct {
  product: CrawledProduct | null;
  etag: string | null;
  statusCode: number | null;
  /** True when the page went through browser rendering (auto JS render). */
  rendered?: boolean;
}

/**
 * Runs a crawl: discovers product URLs (sitemap + html-crawl + Shopify
 * collections), then for each URL tries the Shopify JSON endpoint and
 * falls back to the HTML extractor chain.
 */
export async function runCrawl(config: CrawlConfig): Promise<CrawlResult> {
  const startedAt = Date.now();
  const products: CrawledProduct[] = [];
  const failures: CrawlFailure[] = [];
  // Phase B: cross-worker resume state (Product.httpState in Mongo) beats the
  // per-machine SQLite checkpoint — ANY worker can skip what another already
  // fetched. Falls back to the checkpoint when no resume state is supplied.
  const store = config.resumeState
    ? null
    : config.checkpointPath
      ? openCheckpointStore(config.checkpointPath)
      : null;
  // etag/lastmod captured per URL this run (fetched AND reused) — the worker
  // hands it to the ingest pipeline so httpState lands in Mongo.
  const httpStateByUrl = new Map<
    string,
    { etag: string | null; lastmod: number | null }
  >();
  let fetchedCount = 0;
  let skippedUnchanged = 0;
  // Debug — live HTTP-request counter. Every request (robots.txt, discovery,
  // product fetches, retried attempts) flows through `HttpOptions.onRequest`
  // and is reported via `config.onRequestCount`; the worker surfaces it on
  // the job for the Active crawls page.
  let requestCount = 0;
  const countRequest = () => {
    requestCount++;
    config.onRequestCount?.(requestCount);
  };

  // Shallow mode (architecture §3.2): a sitemap-only check that fetches just
  // the NEW products. Discovery is sitemap-only (no platform detection, no
  // homepage analysis, no HTML BFS, no API probes) and filters out the URLs
  // the system already knows (`knownUrls` from the Product collection); the
  // fetch loop uses the HTML extractor only — no API-first adapters, no
  // Shopify JSON probes — so the whole run costs ≈1 request + new pages.
  const shallow = config.mode === "shallow";

  // Structured run-log (Phase 5 observability): every emit lands on the
  // CrawlJob's capped progress.log via the worker, so a crawl's story
  // survives the process. No-op when the caller didn't wire onLog (the
  // standalone scripts run without it).
  const log = (level: "info" | "warn" | "error", message: string) =>
    config.onLog?.(level, message);

  // Step 5 politeness: robots.txt (fetched once, unless disabled) + adaptive
  // throttle + bounded per-host concurrency. Every HTTP request in this crawl
  // flows through them.
  log(
    "info",
    `${shallow ? "shallow check" : "deep crawl"} started — ${config.origin}` +
      (config.proxy ? " via residential proxy" : "") +
      (config.locale ? ` (region: ${config.locale})` : "")
  );
  const respectRobots = config.respectRobotsTxt !== false;
  // Per-store UA setting: the `"browser"` sentinel resolves to a Chrome UA
  // (for WAF-blocked stores that 403 the ParityBot UA — dawlance/prosportsae/
  // athletix); any other string passes through raw. The resolution lives in
  // http.ts next to the constant (single source of truth).
  const userAgent = resolveUserAgent(config.userAgent);
  const politeness = await Politeness.load(config.origin, {
    userAgent,
    delayMs: config.delayMs,
    respectRobots,
    // Tier 2: robots.txt is fetched from the same (possibly IP-blocked)
    // origin, so it goes through the proxy too.
    proxy: config.proxy,
    onRequest: countRequest,
  });
  const opts = httpOptions(config, {
    userAgent,
    throttle: politeness,
    isAllowed: respectRobots
      ? (url) => politeness.isUrlAllowed(url)
      : undefined,
    // Tier 1 (Playwright): AUTO mode (default). The renderer is always wired;
    // core/http.ts's `needsBrowserRender` decides PER PAGE whether a browser
    // is genuinely needed — only content-poor JS-shell pages (Nuxt/SPA shells,
    // bot-block pages) are rendered in headless Chromium, so content-rich
    // server-rendered stores never touch the browser and stay fast. Set
    // `useBrowser: false` to disable rendering entirely. Lazy — browser.ts
    // only loads playwright on first render.
    ...(config.useBrowser !== false
      ? {
          renderWithBrowser: (url: string) =>
            renderWithBrowser(url, {
              userAgent,
              // Tier 2: JS-shell pages render from the proxy too — the HTTP
              // layer already exits through it, and a WAF that blocks the
              // machine's IP must not spare the browser-rendered pages.
              proxy: config.proxy,
            }),
        }
      : {}),
    onRequest: countRequest,
  });
  const concurrency = config.maxConcurrencyPerHost ?? DEFAULT_MAX_PER_HOST;
  const limiter = new HostLimiter(concurrency);

  // Pass the robots.txt snapshot politeness already fetched so platform
  // detection doesn't refetch it and the presence/crawl-delay is recorded
  // in the discovery diagnostics. Hoisted above the try so a failed
  // discovery still reports the true robots outcome in its empty result.
  const robotsSnapshot: RobotsSnapshot | null = respectRobots
    ? {
        body: politeness.robotsBody,
        status: politeness.robotsStatus,
        crawlDelayMs: politeness.robotsCrawlDelayMs,
      }
    : null;
  if (respectRobots) {
    log(
      politeness.robotsStatus === "found" ? "info" : "warn",
      `robots.txt ${politeness.robotsStatus}${politeness.robotsCrawlDelayMs ? ` (crawl-delay ${Math.round(politeness.robotsCrawlDelayMs / 1000)}s)` : ""}`
    );
  }
  // Mid-crawl checkpoint (Step 4, Aug 2026): a `resumeCheckpoint` (written by
  // a previous run of this job before a crash/restart) skips discovery
  // entirely — the URL list, lastmod map, diagnostics and BigCommerce id map
  // are rebuilt from the snapshot, so a re-claimed job continues the fetch
  // phase instead of re-walking sitemaps + probes from zero.
  const resume =
    config.resumeCheckpoint?.v === 1 ? config.resumeCheckpoint : null;
  let discovered;
  if (resume) {
    discovered = {
      urls: resume.urls,
      lastmod: new Map(resume.lastmod),
      productIds: new Map(resume.productIds),
      diagnostics: resume.discovery,
    };
    log(
      "info",
      `resuming from checkpoint — ${resume.products.length.toLocaleString()} products, ${resume.done.length.toLocaleString()} URLs already processed (discovery skipped)`
    );
  } else {
    try {
      discovered = await discoverProducts(config, opts, robotsSnapshot);
      log(
        "info",
        `discovery done — ${discovered.urls.length.toLocaleString()} product URLs` +
          (discovered.diagnostics.platform?.platform
            ? ` (${discovered.diagnostics.platform.platform})`
            : "")
      );
    } catch (error) {
      store?.close();
    // Tier 1: release the shared browser so the process can exit / the job
    // finishes cleanly (no-op when browser rendering was never used).
    if (config.useBrowser !== false) await closeBrowser();
    // Tier 2: close the proxy agent's keep-alive sockets too — a crawl that
    // died mid-discovery must not leave the gateway connection open (socket
    // leak across jobs, delayed process exit).
    if (config.proxy) closeProxyAgent(config.proxy);
    // A user-requested cancel must NOT be swallowed into an "empty result" —
    // it unwinds the whole crawl so the worker can mark the job cancelled.
    if (isCrawlCancelled(error)) throw error;
    log("error", `discovery failed — ${String(error).slice(0, 300)}`);
    return emptyResult(
      config,
      startedAt,
      [
        {
          url: config.origin,
          error: `Discovery failed: ${String(error)}`,
          // Network-level failure (sitemap fetch threw / was blocked).
          kind: 'http',
        },
      ],
      robotsSnapshot
        ? {
            status: robotsSnapshot.status,
            crawlDelayMs: robotsSnapshot.crawlDelayMs,
          }
        : undefined,
      // Requests made before the failure still count.
      requestCount,
    );
    }
  }

  // Optional page cap: crawl at most `maxPages` of the discovered URLs.
  // `stats.discovered` still reports the full discovery; only the fetch
  // loop is limited. When discovery found more URLs than the cap, the run
  // is NOT a full catalogue (`stats.capped`) — the ingest pipeline must
  // not read the URLs beyond the cap as removals.
  //
  // A capped run samples the catalogue, so the sample must SPAN it — take
  // evenly-spaced URLs, not the first `maxPages`. Discovery orders URLs by
  // sitemap file, and stores whose "product" sitemaps mix brand/category
  // landing pages in (e.g. activefitnessstore.com's /om/<brand> pages) can
  // cluster all of them at the HEAD of the list: a first-N cap then fetches
  // 400 brand pages and zero products (observed Aug 2026). Stratified
  // sampling keeps the cap representative of the whole store.
  // On a resumed run the checkpoint's URL list IS the fetch list (it was
  // already capped/stratified) — and `discovered.urls` only holds that same
  // list, so the full pre-cap count comes from the checkpoint instead of
  // `stats.discovered` silently shrinking to the sample.
  const fullDiscovered = resume ? resume.discoveredCount : discovered.urls.length;
  const urlsToFetch = resume
    ? resume.urls
    : config.maxPages != null && config.maxPages > 0
      ? stratifiedSample(discovered.urls, config.maxPages)
      : discovered.urls;
  let capped = urlsToFetch.length < fullDiscovered;
  // URLs already fully processed by the dead run (product, cached-skip, or
  // failure) — their outcome is seeded below and they're skipped in the loop.
  const done = resume ? new Set(resume.done) : new Set<string>();
  // Seed the run state captured by the dead run's checkpoint so progress,
  // stats and the final result are identical to a run that never crashed —
  // the resumed fetch phase just appends to what's already in hand.
  if (resume) {
    products.push(...resume.products);
    failures.push(...resume.failures);
    fetchedCount = resume.fetchedCount;
    skippedUnchanged = resume.skippedUnchanged;
    for (const [u, state] of resume.httpState) httpStateByUrl.set(u, state);
  }
  // Render-miss circuit breaker (Aug 2026): when a crawl renders page after
  // page (auto JS rendering ON) and N CONSECUTIVE rendered pages extract no
  // product, the store almost certainly loads its prices via a client-side
  // API the crawler can't see (activefitnessstore.com rendered 11k pages to
  // extract 16). Stop the fetch loop early instead of burning thousands of
  // renders. The partial result is kept; `capped` is set so the ingest diff
  // doesn't read the skipped URLs as removals; a finding explains the stop.
  const renderMissBreaker = config.renderMissBreaker ?? 25;
  let renderMisses = 0;
  let renderBreakerTripped = false;

  // Store-detour hints (Aug 2026): a corporate site's product pages often
  // carry a "Buy Now" button that links out to the REAL priced storefront
  // (haier.com/pk → haiermall.pk). Pages that fail extraction may still have
  // that link — aggregate the hosts so a 0-product run explains itself
  // instead of reading as a broken crawl.
  const externalStoreHints = new Map<string, { url: string; count: number }>();
  const noteStoreLink = (html: string, pageUrl: string) => {
    try {
      for (const l of analyzeHomepage(html, pageUrl).externalStoreLinks) {
        const cur = externalStoreHints.get(l.host);
        if (cur) cur.count++;
        else externalStoreHints.set(l.host, { url: l.url, count: 1 });
      }
    } catch {
      // A malformed page must never break the crawl — hints are best-effort.
    }
  };

  // Tier 3 (WooCommerce native): when discovery found a public /wp-json/wc/v3
  // API, the fetch loop prefers structured per-product JSON (SKU/GTIN/price/
  // stock) over the Shopify probe + HTML extractor chain. Shallow mode never
  // probes these (platform detection was skipped), so both are always false
  // there — the HTML-only path is exactly what a 1-request check needs.
  const wooApiAvailable =
    !shallow && discovered.diagnostics.wooCommerce?.status === "public";
  // Tier 3 (BigCommerce Storefront): same idea — when discovery walked the
  // public /api/storefront/catalog/products, the fetch loop pulls each
  // product by id (URL → id map from the walk) instead of scraping HTML.
  const bcApiAvailable =
    !shallow && discovered.diagnostics.bigCommerce?.status === "public";

  // Tier 1 probe skip: when discovery positively identified a NON-Shopify
  // platform (WooCommerce / WordPress / Magento / BigCommerce / Wix / …), the
  // per-product Shopify /products/{handle}.json probe can only 404 — a wasted
  // request per product, roughly HALF the fetch-phase traffic on big
  // non-Shopify stores. "Unknown" (or absent detection) keeps probing: it may
  // still be a Shopify store, and the probe is the cheap first guess there.
  const skipShopifyProbe =
    !shallow &&
    discovered.diagnostics.platform?.platform != null &&
    !["Shopify", "Unknown"].includes(discovered.diagnostics.platform.platform);

  // Tier 4 headless storefront API (activefitnessstore.com class): when
  // discovery found the store's native JSON API (fetchPage → catalogue →
  // batched get-price), build the per-URL index + price map BEFORE the main
  // loop so prices can be BATCHED (1 request per ~100 products instead of 1
  // per product). Stores without the API skip this entirely (recipe absent).
  // The index walk costs 1 fetchPage request per URL; products whose
  // fetchPage call fails simply don't make the map and fall through to the
  // normal chain below.
  const storefrontRecipe = !shallow
    ? (discovered.diagnostics.storefrontApi?.recipe ?? null)
    : null;
  let storefrontByUrl: Map<string, StorefrontUrlInfo> | null = null;
  let storefrontPrices: Map<number, StorefrontPrice> | null = null;
  if (storefrontRecipe) {
    if (resume?.storefrontByUrl && resume.storefrontByUrl.length > 0) {
      // Resume: the dead run already walked fetchPage for every URL (1
      // request each — 11k requests on a big store) and batched the prices.
      // Rebuild from the checkpoint instead of re-walking.
      storefrontByUrl = new Map(resume.storefrontByUrl);
      storefrontPrices = new Map(resume.storefrontPrices ?? []);
      log(
        "info",
        `storefront API index resumed from checkpoint — ${storefrontByUrl.size.toLocaleString()} URLs, ${storefrontPrices.size.toLocaleString()} prices`
      );
    } else {
      log(
        "info",
        `storefront API public — indexing ${urlsToFetch.length.toLocaleString()} URLs via fetchPage…`
      );
      const indexed = await indexStorefrontProducts(
        urlsToFetch,
        storefrontRecipe,
        opts,
        concurrency,
        config.control,
        // The index walk is part of the fetch phase — report it so the UI
        // shows movement instead of a stalled 0/N while fetchPage runs.
        (indexedCount, total) =>
          config.onProgress?.(Math.round((indexedCount / total) * total), total),
      );
      storefrontByUrl = indexed.byUrl;
      log(
        "info",
        `storefront API indexed ${indexed.byUrl.size.toLocaleString()} of ${urlsToFetch.length.toLocaleString()} URLs — fetching batched prices`
      );
      storefrontPrices = await fetchStorefrontPrices(
        storefrontRecipe,
        indexed.byUrl,
        opts,
        config.control,
      );
      log(
        "info",
        `storefront API prices: ${storefrontPrices.size.toLocaleString()} products priced (batched get-price)`
      );
    }
  }

  // `onProgress` first arg = products in hand (freshly fetched + cache-reused),
  // i.e. progress through the run; `stats.fetched` is the fresh-only count.
  // try/finally guarantees the checkpoint/resume store is closed even if a
  // worker throws (e.g. a user onProgress callback).
  if (capped) {
    log(
      "info",
      `maxPages cap — fetching ${urlsToFetch.length.toLocaleString()} of ${fullDiscovered.toLocaleString()} discovered URLs (stratified sample)`
    );
  }
  // Mid-crawl checkpoint emission (Step 4, Aug 2026): a throttled JSON
  // snapshot of the run's fetch-phase state handed to `config.onCheckpoint`
  // (the worker persists it on the job). A crash/restart then loses at most
  // ~CHECKPOINT_INTERVAL_MS of work — the resume path rebuilds discovery and
  // the storefront index from the snapshot instead of re-running them.
  let lastCheckpointAt = 0;
  const CHECKPOINT_INTERVAL_MS = 15_000;
  const emitCheckpoint = () => {
    if (!config.onCheckpoint) return;
    const now = Date.now();
    if (now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt = now;
    try {
      config.onCheckpoint({
        v: 1,
        urls: urlsToFetch,
        lastmod: [...discovered.lastmod.entries()],
        productIds: [...discovered.productIds.entries()],
        done: [...done],
        products,
        failures,
        fetchedCount,
        skippedUnchanged,
        discoveredCount: fullDiscovered,
        discovery: discovered.diagnostics,
        httpState: [...httpStateByUrl.entries()],
        ...(storefrontByUrl
          ? { storefrontByUrl: [...storefrontByUrl.entries()] }
          : {}),
        ...(storefrontPrices
          ? { storefrontPrices: [...storefrontPrices.entries()] }
          : {}),
      });
    } catch {
      // A failing checkpoint must never break the crawl.
    }
  };
  try {
    await runWithConcurrency(urlsToFetch, concurrency, async (url) => {
      // Cooperative control: pause waits here, cancel throws. Checked before
      // every URL so a pause/cancel lands within ~one in-flight request.
      await waitForControl(config.control);
      // Render-miss circuit breaker tripped — the loop drains immediately
      // (no more fetches; the partial result is what we ship).
      if (renderBreakerTripped) return;
      // Resumed run: this URL was already fully processed before the crash —
      // its product (or failure) is seeded from the checkpoint; skip it.
      if (done.has(url)) return;

      // Resume fast-path: content unchanged since the last successful run
      // (sitemap lastmod match against Product.httpState, or etag match after
      // a conditional fetch) → reuse instead of refetching. Skipped products
      // are counted in `skippedUnchanged` and INCLUDED in the result, so the
      // ingest diff sees the full catalogue (no false removals) — and their
      // httpState is carried forward for persistence.
      const lastmod = discovered.lastmod.get(url) ?? undefined;
      const lastmodNum =
        lastmod && !Number.isNaN(Date.parse(lastmod))
          ? Date.parse(lastmod)
          : null;
      // Phase B resume fast-path: sitemap lastmod unchanged since the last
      // crawl (Product.httpState) → reuse the stored product instead of
      // refetching. The reused product IS part of the result, so the ingest
      // diff still sees the full catalogue (no false removals).
      const prev = config.resumeState?.get(url);
      // Only a REAL lastmod signal can skip without a request: when both the
      // sitemap and the stored state have no lastmod (null === null), the
      // product MUST be revalidated — skipping would never refresh the store
      // (the conditional-request path below turns that into a cheap 304).
      if (prev && lastmodNum != null && lastmodNum === prev.lastmod) {
        products.push(prev.product);
        skippedUnchanged++;
        // Carry the stored etag forward — the product didn't change, so its
        // etag is still valid. Keyed by the PRODUCT's stored URL (not the
        // sitemap loc) so the ingest pipeline's httpState lookup by product
        // URL always finds it.
        httpStateByUrl.set(prev.product.url, {
          etag: prev.etag,
          lastmod: lastmodNum,
        });
        done.add(url);
        config.onProgress?.(products.length, urlsToFetch.length);
        return;
      }
      if (
        store &&
        !store.shouldFetch({ origin: config.origin, url, lastmod })
      ) {
        const cached = store.getCachedProduct(config.origin, url);
        if (cached) {
          products.push(cached);
          skippedUnchanged++;
          httpStateByUrl.set(url, { etag: null, lastmod: lastmodNum });
          done.add(url);
          config.onProgress?.(products.length, urlsToFetch.length);
          return;
        }
        // Row exists but carries no product JSON — fall through and refetch.
      }

      // Conditional revalidation: when we have stored validators (etag /
      // lastmod) but the sitemap-lastmod fast-path above didn't trigger, ask
      // the server "is this still the same?" — a 304 answers with no body, so
      // unchanged pages cost one tiny request instead of a full fetch + parse.
      // No validators → plain fetch (nothing to revalidate against).
      const conditional: ConditionalRequest | undefined =
        prev && (prev.etag || prev.lastmod != null)
          ? { etag: prev.etag, lastmod: prev.lastmod }
          : undefined;

      // Tier 4 storefront fast-path: the store's native API already gave us
      // this URL's product id + catalogue JSON URL (and a batched price).
      // Fetch the catalogue (1 request) and assemble the product — no HTML,
      // no Shopify probe, no browser. Failures fall through to the normal
      // chain below (catalogue fetch failing = the HTML chain still runs).
      // Robots.txt was already enforced during discovery (disallowed URLs were
      // dropped from `discovered.urls`), so no extra gate is needed here.
      const host = hostOf(url);
      await limiter.acquire(host);
      try {
        try {
          // Tier 4 storefront fast-path: the store's native API already gave
          // us this URL's product id + catalogue JSON URL (and a batched
          // price). Fetch the catalogue (1 request) and assemble the product
          // — no HTML, no Shopify probe, no browser.
          const sfInfo = storefrontByUrl?.get(url);
          if (sfInfo) {
            const price = storefrontPrices?.get(sfInfo.productId);
            const product = await fetchStorefrontProduct(
              url,
              sfInfo,
              price,
              opts,
            );
            if (product) {
              store?.recordFetch({
                origin: config.origin,
                url,
                etag: null,
                lastmod: lastmod ?? null,
                statusCode: 200,
                status: "fetched",
                productJson: JSON.stringify(product),
                lastFetchedAt: new Date().toISOString(),
              });
              httpStateByUrl.set(url, { etag: null, lastmod: lastmodNum });
              products.push(product);
              fetchedCount++;
              done.add(url);
              // A storefront-API product extracted fine — reset the render
              // miss streak (the store works; nothing is broken).
              renderMisses = 0;
            } else {
              failures.push({
                url,
                error: "Storefront catalogue returned no product data",
                kind: "extraction",
              });
              store?.recordFailure(config.origin, url);
              done.add(url);
            }
            config.onProgress?.(products.length, urlsToFetch.length);
            return;
          }

          const bcId = bcApiAvailable
            ? (discovered.productIds.get(url) ?? null)
            : null;
          const { product, etag, statusCode, rendered } = await fetchOneProduct(
            url,
            config.origin,
            opts,
            wooApiAvailable,
            bcId,
            shallow,
            conditional,
            skipShopifyProbe,
            // Failed extraction → scan the page for external store links
            // (the buy-now button to the real priced storefront).
            noteStoreLink,
          );
          if (product) {
            // A real product came out of the HTML chain — reset the render
            // miss streak (rendering IS working for this store).
            renderMisses = 0;
            // Persist before mutating run state so a storage failure can't
            // desync `products`/`fetchedCount` from `stats`.
            store?.recordFetch({
              origin: config.origin,
              url,
              // Etag is persisted for future conditional-request revalidation;
              // the sitemap lastmod is the first skip signal, etag the second.
              etag,
              lastmod: lastmod ?? null,
              statusCode,
              status: "fetched",
              productJson: JSON.stringify(product),
              lastFetchedAt: new Date().toISOString(),
            });
            httpStateByUrl.set(url, { etag, lastmod: lastmodNum });
            products.push(product);
            fetchedCount++;
            done.add(url);
          } else if (statusCode === 304 && prev?.product) {
            // 304 Not Modified — the stored validators are still current, so
            // the stored product is reused (cheap revalidation). Counted as a
            // skip and INCLUDED in the result so the ingest diff still sees
            // the full catalogue (no false removals).
            store?.recordFetch({
              origin: config.origin,
              url,
              etag: prev.etag ?? etag,
              lastmod: lastmod ?? null,
              statusCode: 304,
              status: "fetched",
              productJson: JSON.stringify(prev.product),
              lastFetchedAt: new Date().toISOString(),
            });
            httpStateByUrl.set(prev.product.url, {
              etag: prev.etag ?? etag,
              lastmod: lastmodNum,
            });
            products.push(prev.product);
            skippedUnchanged++;
            done.add(url);
            renderMisses = 0;
          } else {
            // P4 failure classification: the page LOADED but no product was
            // parsed from it (extraction miss) — not an HTTP failure. A
            // 0-priced run made of these reads "the store loaded, nothing
            // parseable", not "we were blocked".
            failures.push({
              url,
              error: "No product data found",
              kind: 'extraction',
            });
            store?.recordFailure(config.origin, url);
            done.add(url);
            // Render-miss circuit breaker: a page that was ACTUALLY rendered
            // in a browser (auto JS rendering ON) and still extracted nothing
            // is a strong "this store loads its prices via a client-side API
            // the crawler can't see" signal. N consecutive such pages → stop
            // the crawl instead of rendering thousands more.
            if (rendered && renderMissBreaker > 0) {
              renderMisses++;
              // Only trip when the run has extracted NOTHING so far — a store
              // that yields any product is working (at least partially) and
              // must never be cut short by a block of junk URLs. And never
              // trip when the storefront API is active: that store HAS a
              // native API the crawler uses (its few non-indexed stragglers
              // are junk brand pages, not evidence the store is broken).
              if (
                renderMisses >= renderMissBreaker &&
                products.length === 0 &&
                !storefrontRecipe
              ) {
                renderBreakerTripped = true;
                capped = true; // partial run — don't read the rest as removals
                log(
                  "warn",
                  `circuit breaker: ${renderMisses} consecutive browser-rendered pages extracted no product and the run has ${products.length} products — this store loads its prices via a client-side API the crawler can't see. Stopping the fetch loop instead of rendering thousands more pages.`
                );
              }
            } else if (!rendered) {
              // A NON-rendered miss (server-rendered page with no product, or
              // rendering disabled) is a normal miss — reset the streak so
              // random junk URLs don't trip the breaker.
              renderMisses = 0;
            }
          }
        } catch (error) {
          // The fetch itself failed (timeout, rate-limit, WAF block,
          // network) — an HTTP-level failure.
          failures.push({ url, error: String(error), kind: 'http' });
          store?.recordFailure(config.origin, url);
          done.add(url);
        }
        config.onProgress?.(products.length, urlsToFetch.length);
        // Throttled mid-crawl checkpoint — the worker persists this on the
        // job so a crash resumes here instead of re-running discovery + the
        // fetch phase from zero.
        emitCheckpoint();
      } finally {
        limiter.release(host);
      }
    });
  } finally {
    store?.close();
  }

  // A run that extracted (almost) NOTHING but kept finding links to a
  // store-like host is a corporate-site detour (haier.com → haiermall.pk):
  // surface the top candidate as a finding with a crawl action, so the user
  // knows where the prices actually live instead of staring at a 0-product
  // result. Threshold is deliberately tiny — a real store extracting ≤5
  // products from hundreds of pages is broken, and the hint is what explains
  // it (haier.com/pk extracted 1 of 883 pages; its Buy Now buttons all point
  // at haiermall.pk).
  if (products.length <= 5 && externalStoreHints.size > 0) {
    const top = [...externalStoreHints.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    )[0];
    const none = products.length === 0;
    discovered.diagnostics.findings.push({
      level: "info",
      message: `${
        none
          ? "No products could be extracted from this site"
          : `Only ${products.length} of ${urlsToFetch.length} pages extracted a product`
      } — its pages keep linking to ${top[0]}, which is where it actually sells. Crawl that domain instead, the prices live there.`,
      action: { label: `Crawl ${top[0]}`, url: top[1].url },
    });
  }

  // Render-miss circuit breaker finding: the crawl stopped itself because
  // page after page RENDERED but extracted nothing — explain it so the user
  // doesn't re-run the same doomed crawl.
  if (renderBreakerTripped) {
    discovered.diagnostics.findings.push({
      level: "warning",
      message:
        "Stopped early: consecutive browser-rendered pages extracted no product — this store loads its prices via a client-side API the crawler can't see (browser rendering shows the shell, not the prices). The crawl stopped after " +
        `${renderMisses} rendered misses instead of burning thousands of renders.` +
        (storefrontRecipe
          ? " The store's native JSON API was used where available."
          : ""),
    });
  }

  // Completion summary — the crawl's story in one line (landed on the job's
  // run log so it's visible after the process exits). P4: the failed count
  // splits extraction-miss vs http so a 0-priced run reads honestly.
  const extractionMisses = failures.filter((f) => f.kind === 'extraction').length;
  const httpFailures = failures.length - extractionMisses;
  log(
    failures.length > 0 ? "warn" : "info",
    `finished — ${products.length.toLocaleString()} products (${fetchedCount.toLocaleString()} fetched, ${skippedUnchanged.toLocaleString()} cached, ${failures.length.toLocaleString()} failed [${extractionMisses.toLocaleString()} extraction-miss · ${httpFailures.toLocaleString()} http]) in ${Math.round((Date.now() - startedAt) / 1000)}s` +
      (capped ? " — capped run" : "")
  );

  // Tier 1: release the shared browser once the crawl is done so the job
  // finishes cleanly and the Chromium process isn't left running.
  if (config.useBrowser !== false) await closeBrowser();
  // Tier 2: same for the proxy agent — close its keep-alive sockets when the
  // crawl finishes so connections can't leak across jobs or delay worker
  // shutdown. A fresh agent is re-created on the next proxied crawl (cheap).
  if (config.proxy) closeProxyAgent(config.proxy);

  return {
    config: { origin: config.origin, collections: config.collections },
    stats: {
      // The full pre-cap discovery count — on a resumed run `discovered.urls`
      // only holds the checkpoint's fetch list, so the true count comes from
      // the checkpoint.
      discovered: fullDiscovered,
      // `fetched` = actually fetched this run; `skippedUnchanged` = reused
      // from the checkpoint/resume cache. `fetched + skippedUnchanged === products.length`.
      fetched: fetchedCount,
      skippedUnchanged,
      failed: failures.length,
      failures,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      requests: requestCount,
      capped,
    },
    products,
    // Surface what each discovery strategy contributed (sitemap / html-crawl /
    // collections) so the UI can show real numbers instead of placeholders.
    discovery: discovered.diagnostics,
    httpStateByUrl,
  };
}

/**
 * Crawls the full catalogue from the products sitemap. Kept for back-compat
 * with the original script; equivalent to `runCrawl` when `collections` is
 * not specified.
 */
export async function runSitemapCrawl(
  config: CrawlConfig,
): Promise<CrawlResult> {
  return runCrawl({ ...config, collections: config.collections ?? [] });
}

/**
 * Fetches a single product URL — BigCommerce Storefront (when public) →
 * WooCommerce REST (when public) → Shopify JSON → HTML extractor chain,
 * whichever returns first.
 */
async function fetchOneProduct(
  url: string,
  origin: string,
  opts: ReturnType<typeof httpOptions>,
  useWooApi = false,
  bcId: number | null = null,
  shallow = false,
  conditional?: ConditionalRequest,
  skipShopifyProbe = false,
  onStoreLink?: (html: string, pageUrl: string) => void,
): Promise<FetchedProduct> {
  // The Shopify handle is needed by the HTML path too (it seeds the
  // extractor), so it's computed here, outside the shallow guard.
  const handle = shopifyHandleFromUrl(url);

  // Shallow mode: the API-first tiers (BigCommerce / WooCommerce / Shopify
  // JSON probes) each cost an extra request per product — exactly what a
  // 1-request shallow check must not do. New pages are fetched once, through
  // the HTML extractor chain only.
  if (!shallow) {
    // Tier 3 (BigCommerce Storefront): structured JSON by id beats HTML
    // scraping. The id comes from the discovery walk's URL → id map. Never
    // throws (null on any failure), so a null result falls through below.
    if (bcId != null) {
      const product = await fetchBigCommerceProductById(origin, bcId, opts);
      if (product) {
        return { product, etag: null, statusCode: 200 };
      }
    }

    // Tier 3 (WooCommerce native): structured JSON beats HTML scraping. Tried
    // before the Shopify probe — on a WooCommerce store the Shopify JSON probe
    // would be a wasted 404. `fetchWooCommerceProductBySlug` never throws
    // (null on any failure), so no try/catch is needed here — a null result
    // simply falls through to the Shopify probe + HTML chain.
    if (useWooApi) {
      const slug = slugFromUrl(url);
      if (slug) {
        const product = await fetchWooCommerceProductBySlug(origin, slug, opts);
        if (product) {
          return { product, etag: null, statusCode: 200 };
        }
      }
    }

    // Tier 1: Shopify JSON endpoint. Skipped entirely when discovery already
    // ruled Shopify out — the probe would 404 on every product (see
    // `skipShopifyProbe` in runCrawl).
    if (handle && !skipShopifyProbe) {
      try {
        const jsonUrl = `${origin}/products/${handle}.json`;
        const response = await fetchWithRetry(jsonUrl, {
          ...opts,
          conditional,
        });
        // 304 = the JSON product is unchanged — bail out so the engine reuses
        // the stored product instead of also fetching the HTML page.
        if (response.status === 304) {
          return {
            product: null,
            etag: response.headers.get("etag"),
            statusCode: 304,
          };
        }
        const envelope = (await response.json()) as ShopifyProductEnvelope;
        if (envelope?.product) {
          return {
            product: parseShopifyProduct(envelope.product, origin),
            etag: response.headers.get("etag"),
            statusCode: response.status,
          };
        }
      } catch {
        // Not a Shopify JSON product — fall through to the HTML path.
      }
    }
  }

  // Tier 2: HTML extractor chain (JSON-LD / OG / microdata / heuristics).
  // fetchHtmlWithStatus applies the auto-render decision (needsBrowserRender →
  // renderWithBrowser) before returning the body — a JS-shell page MUST be
  // rendered or the raw HTML carries no product data (Aug 2026: the fetch
  // loop used fetchWithRetry directly, so auto JS rendering never ran for
  // products and every Next.js store crawled to zero prices).
  const {
    status,
    etag,
    body: html,
    rendered,
  } = await fetchHtmlWithStatus(url, {
    ...opts,
    conditional,
  });
  // 304 = page unchanged — the engine reuses the stored product.
  if (status === 304) {
    return { product: null, etag, statusCode: 304 };
  }
  const htmlHandle = handle ?? slugFromUrl(url);
  const product = extractFromHtml(html, url, origin, htmlHandle);
  // Extraction failed but the page is in hand — it may carry the "Buy Now"
  // link to the real priced storefront (store-detour hint). Best-effort
  // anchor scan; never throws (the crawl's own error handling covers fetch
  // failures, this is purely additive diagnostics).
  if (!product && onStoreLink) {
    try {
      onStoreLink(html, url);
    } catch {
      // Ignore — hints are optional diagnostics.
    }
  }
  return {
    product,
    etag,
    statusCode: status,
    rendered,
  };
}

/**
 * Picks at most `maxPages` URLs from a larger list, spread evenly across it
 * (strata) instead of taking the head. `maxPages >= list.length` returns the
 * list unchanged. Indices are strictly increasing, so the sample never
 * duplicates a URL.
 */
function stratifiedSample<T>(urls: T[], maxPages: number): T[] {
  if (urls.length <= maxPages) return urls;
  const step = urls.length / maxPages;
  const out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    out.push(urls[Math.min(urls.length - 1, Math.floor(i * step))]);
  }
  return out;
}

function shopifyHandleFromUrl(url: string): string | null {
  // Shopify handles are lowercase letters, digits, hyphens AND underscores
  // (`…-sab-06_r` is a real handle on athletix.ae) — the underscore is the
  // part the older [a-z0-9-]+ missed, silently dropping those products to
  // the HTML extractor chain instead of the structured JSON probe.
  const m = url.match(/\/products\/([a-z0-9_-]+)(?:\.json)?$/i);
  return m?.[1] ?? null;
}

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? u.hostname;
  } catch {
    return url;
  }
}

function emptyResult(
  config: CrawlConfig,
  startedAt: number,
  failures: CrawlFailure[],
  robots: RobotsInfo = { status: "skipped", crawlDelayMs: null },
  requests = 0,
): CrawlResult {
  return {
    config: { origin: config.origin, collections: config.collections },
    stats: {
      discovered: 0,
      fetched: 0,
      skippedUnchanged: 0,
      failed: failures.length,
      failures,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      requests,
      capped: false,
    },
    products: [],
    discovery: {
      collections: [],
      sitemap: { urls: 0, lastmod: 0 },
      htmlCrawl: { urls: 0, pagesVisited: 0, truncated: false },
      platform: {
        platform: "Unknown",
        signal: "Crawl did not run",
        kind: "unknown",
      },
      robots,
      findings: [
        {
          level: "warning",
          message: "Discovery failed before any product URLs were found.",
        },
      ],
      log: ["Discovery failed."],
    },
  };
}
