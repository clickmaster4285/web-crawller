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
  closeProxyAgent,
  fetchHtmlWithStatus,
  fetchWithRetry,
  httpOptions,
  sanitizeProxyFromMessage,
  type ConditionalRequest,
} from "./core/http.ts";
import { closeBrowser, renderWithBrowser } from "./core/browser.ts";
import { fetchBigCommerceProductById } from "./adapters/bigcommerce.ts";
import { parseShopifyProduct, type RawProduct } from "./adapters/shopify.ts";
import { fetchWooCommerceProductBySlug } from "./adapters/woocommerce.ts";
import { extractFromHtml } from "./extract/mapper.ts";
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

  // Step 5 politeness: robots.txt (fetched once, unless disabled) + adaptive
  // throttle + bounded per-host concurrency. Every HTTP request in this crawl
  // flows through them.
  const respectRobots = config.respectRobotsTxt !== false;
  const politeness = await Politeness.load(config.origin, {
    userAgent: config.userAgent,
    delayMs: config.delayMs,
    respectRobots,
    // Tier 2: robots.txt is fetched from the same (possibly IP-blocked)
    // origin, so it goes through the proxy too.
    proxy: config.proxy,
    onRequest: countRequest,
  });
  const opts = httpOptions(config, {
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
              userAgent: config.userAgent,
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
  let discovered;
  try {
    discovered = await discoverProducts(config, opts, robotsSnapshot);
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
    return emptyResult(
      config,
      startedAt,
      [{ url: config.origin, error: `Discovery failed: ${String(error)}` }],
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
  const urlsToFetch =
    config.maxPages != null && config.maxPages > 0
      ? stratifiedSample(discovered.urls, config.maxPages)
      : discovered.urls;
  const capped = urlsToFetch.length < discovered.urls.length;

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

  // `onProgress` first arg = products in hand (freshly fetched + cache-reused),
  // i.e. progress through the run; `stats.fetched` is the fresh-only count.
  // try/finally guarantees the checkpoint/resume store is closed even if a
  // worker throws (e.g. a user onProgress callback).
  try {
    await runWithConcurrency(urlsToFetch, concurrency, async (url) => {
      // Cooperative control: pause waits here, cancel throws. Checked before
      // every URL so a pause/cancel lands within ~one in-flight request.
      await waitForControl(config.control);

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

      // Robots.txt was already enforced during discovery (disallowed URLs were
      // dropped from `discovered.urls`), so no extra gate is needed here.
      const host = hostOf(url);
      await limiter.acquire(host);
      try {
        try {
          const bcId = bcApiAvailable
            ? (discovered.productIds.get(url) ?? null)
            : null;
          const { product, etag, statusCode } = await fetchOneProduct(
            url,
            config.origin,
            opts,
            wooApiAvailable,
            bcId,
            shallow,
            conditional,
            skipShopifyProbe,
          );
          if (product) {
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
          } else {
            failures.push({ url, error: "No product data found" });
            store?.recordFailure(config.origin, url);
          }
        } catch (error) {
          failures.push({ url, error: String(error) });
          store?.recordFailure(config.origin, url);
        }
        config.onProgress?.(products.length, urlsToFetch.length);
      } finally {
        limiter.release(host);
      }
    });
  } finally {
    store?.close();
  }

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
      discovered: discovered.urls.length,
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
  } = await fetchHtmlWithStatus(url, {
    ...opts,
    conditional,
  });
  // 304 = page unchanged — the engine reuses the stored product.
  if (status === 304) {
    return { product: null, etag, statusCode: 304 };
  }
  const htmlHandle = handle ?? slugFromUrl(url);
  return {
    product: extractFromHtml(html, url, origin, htmlHandle),
    etag,
    statusCode: status,
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
