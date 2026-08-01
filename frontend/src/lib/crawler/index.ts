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
import { fetchWithRetry, httpOptions } from "./core/http.ts";
import { parseShopifyProduct, type RawProduct } from "./adapters/shopify.ts";
import { extractFromHtml } from "./extract/mapper.ts";
import { openCheckpointStore } from "./core/checkpoint.ts";
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
  const store = config.checkpointPath
    ? openCheckpointStore(config.checkpointPath)
    : null;
  let fetchedCount = 0;
  let skippedUnchanged = 0;

  // Step 5 politeness: robots.txt (fetched once) + adaptive throttle + bounded
  // per-host concurrency. Every HTTP request in this crawl flows through them.
  const politeness = await Politeness.load(config.origin, {
    userAgent: config.userAgent,
    delayMs: config.delayMs,
  });
  const opts = httpOptions(config, {
    throttle: politeness,
    isAllowed: (url) => politeness.isUrlAllowed(url),
  });
  const concurrency = config.maxConcurrencyPerHost ?? DEFAULT_MAX_PER_HOST;
  const limiter = new HostLimiter(concurrency);

  let discovered;
  try {
    discovered = await discoverProducts(config, opts);
  } catch (error) {
    store?.close();
    return emptyResult(config, startedAt, [
      { url: config.origin, error: `Discovery failed: ${String(error)}` },
    ]);
  }

  // `onProgress` first arg = products in hand (freshly fetched + cache-reused),
  // i.e. progress through the run; `stats.fetched` is the fresh-only count.
  // try/finally guarantees the checkpoint store is closed even if a worker
  // throws (e.g. a user onProgress callback).
  try {
    await runWithConcurrency(discovered.urls, concurrency, async (url) => {
      // Checkpoint fast-path: content unchanged since the last successful run
      // (sitemap lastmod match) → reuse the cached product instead of refetching.
      const lastmod = discovered.lastmod.get(url) ?? undefined;
      if (
        store &&
        !store.shouldFetch({ origin: config.origin, url, lastmod })
      ) {
        const cached = store.getCachedProduct(config.origin, url);
        if (cached) {
          products.push(cached);
          skippedUnchanged++;
          config.onProgress?.(products.length, discovered.urls.length);
          return;
        }
        // Row exists but carries no product JSON — fall through and refetch.
      }

      // Robots.txt was already enforced during discovery (disallowed URLs were
      // dropped from `discovered.urls`), so no extra gate is needed here.
      const host = hostOf(url);
      await limiter.acquire(host);
      try {
        try {
          const { product, etag, statusCode } = await fetchOneProduct(
            url,
            config.origin,
            opts,
          );
          if (product) {
            // Persist before mutating run state so a storage failure can't
            // desync `products`/`fetchedCount` from `stats`.
            store?.recordFetch({
              origin: config.origin,
              url,
              // Etag is persisted for future conditional-request revalidation;
              // the v1 skip signal is the sitemap lastmod (see `shouldFetch`).
              etag,
              lastmod: lastmod ?? null,
              statusCode,
              status: "fetched",
              productJson: JSON.stringify(product),
              lastFetchedAt: new Date().toISOString(),
            });
            products.push(product);
            fetchedCount++;
          } else {
            failures.push({ url, error: "No product data found" });
            store?.recordFailure(config.origin, url);
          }
        } catch (error) {
          failures.push({ url, error: String(error) });
          store?.recordFailure(config.origin, url);
        }
        config.onProgress?.(products.length, discovered.urls.length);
      } finally {
        limiter.release(host);
      }
    });
  } finally {
    store?.close();
  }

  return {
    config: { origin: config.origin, collections: config.collections },
    stats: {
      discovered: discovered.urls.length,
      // `fetched` = actually fetched this run; `skippedUnchanged` = reused
      // from the checkpoint cache. `fetched + skippedUnchanged === products.length`.
      fetched: fetchedCount,
      skippedUnchanged,
      failed: failures.length,
      failures,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
    products,
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

/** Fetches a single product URL — Shopify JSON first, HTML extractor fallback. */
async function fetchOneProduct(
  url: string,
  origin: string,
  opts: ReturnType<typeof httpOptions>,
): Promise<FetchedProduct> {
  // Tier 1: Shopify JSON endpoint.
  const handle = shopifyHandleFromUrl(url);
  if (handle) {
    try {
      const jsonUrl = `${origin}/products/${handle}.json`;
      const response = await fetchWithRetry(jsonUrl, opts);
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

  // Tier 2: HTML extractor chain (JSON-LD / OG / microdata / heuristics).
  const response = await fetchWithRetry(url, opts);
  const html = await response.text();
  const htmlHandle = handle ?? slugFromUrl(url);
  return {
    product: extractFromHtml(html, url, origin, htmlHandle),
    etag: response.headers.get("etag"),
    statusCode: response.status,
  };
}

function shopifyHandleFromUrl(url: string): string | null {
  const m = url.match(/\/products\/([a-z0-9-]+)(?:\.json)?$/i);
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
    },
    products: [],
  };
}
