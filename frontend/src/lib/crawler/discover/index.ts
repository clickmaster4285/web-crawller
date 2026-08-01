/**
 * Unified product discovery.
 *
 * Combines all available strategies into a single set of product URLs:
 *   1. Shopify collection page walks (if `collections` is set)
 *   2. Sitemap walk (if available)
 *   3. HTML link-graph BFS from the site root (fallback)
 *
 * Each strategy contributes URLs; the union is deduped. Failures in any one
 * strategy don't block the others — they're recorded but the run continues.
 *
 * After this step, the engine has a flat list of product page URLs and
 * `lastmod` (when the sitemap supplied it).
 */

import { discoverCollectionHandles } from "../adapters/shopify-discover.ts";
import { discoverByHtmlCrawl } from "./html-crawl.ts";
import { detectPlatform } from "./platform.ts";
import { fetchSitemapUrls, type DiscoveredUrl } from "./sitemap.ts";
import type { CrawlConfig } from "../core/types.ts";
import type { HttpOptions } from "../core/http.ts";
import { httpOptions } from "../core/http.ts";

const DISCOVERY_MAX_PAGES = 60;
const DISCOVERY_MAX_DEPTH = 3;

export interface ProductDiscovery {
  /** Absolute product page URLs, deduped. */
  urls: string[];
  /** URLs that the sitemap paired with a lastmod value. */
  lastmod: Map<string, string>;
  /** Diagnostics from each strategy. */
  diagnostics: {
    collections: { collection: string; handles: number; error?: string }[];
    sitemap: { urls: number; lastmod: number; error?: string };
    htmlCrawl: {
      urls: number;
      pagesVisited: number;
      truncated: boolean;
      error?: string;
    };
    platform: { platform: string; signal: string };
  };
}

/**
 * Discovers product URLs using all available strategies. Each strategy runs
 * in isolation; failures are captured in `diagnostics` rather than thrown.
 *
 * When `opts.isAllowed` (robots.txt gate) is provided, disallowed product
 * URLs are dropped from the returned set.
 */
export async function discoverProducts(
  config: CrawlConfig,
  opts: HttpOptions = httpOptions(config),
  /** robots.txt body already fetched by the politeness layer (avoids a refetch). */
  robotsBody?: string | null,
): Promise<ProductDiscovery> {
  const urlSet = new Set<string>();
  const lastmod = new Map<string, string>();
  const diagnostics: ProductDiscovery["diagnostics"] = {
    collections: [],
    sitemap: { urls: 0, lastmod: 0 },
    htmlCrawl: { urls: 0, pagesVisited: 0, truncated: false },
    platform: { platform: "Unknown", signal: "Not detected" },
  };

  // Platform detection (robots.txt body + one polite homepage fetch when the
  // body alone isn't conclusive). Runs first so the result lands in the
  // diagnostics and the final live tick.
  try {
    diagnostics.platform = await detectPlatform(
      config.origin,
      opts,
      robotsBody,
    );
  } catch (error) {
    diagnostics.platform = {
      platform: "Unknown",
      signal: `Detection failed: ${String(error)}`,
    };
  }

  // 1. Shopify collection handles → product URLs.
  if (config.collections?.length) {
    for (const collection of config.collections) {
      try {
        const handles = await discoverCollectionHandles(
          config.origin,
          collection,
          opts,
        );
        for (const h of handles) {
          urlSet.add(`${config.origin}/products/${h}`);
        }
        diagnostics.collections.push({ collection, handles: handles.length });
      } catch (error) {
        diagnostics.collections.push({
          collection,
          handles: 0,
          error: String(error),
        });
      }
      config.onDiscoveryProgress?.({
        phase: "collections",
        urlsFound: urlSet.size,
        sitemapUrls: 0,
        htmlUrls: 0,
        htmlPagesVisited: 0,
        collectionHandles: diagnostics.collections.reduce(
          (n, c) => n + c.handles,
          0,
        ),
      });
    }
  }

  // 2. Sitemap walk (any platform).
  try {
    const sitemapUrls = await fetchSitemapUrls(
      `${config.origin}/sitemap.xml`,
      opts,
    );
    // Product-only mode (default) skips blog/help/policy pages; off means
    // every sitemap URL is crawled (non-product pages usually fail parse).
    const entries =
      config.productOnly === false
        ? sitemapUrls
        : filterProductSitemapEntries(sitemapUrls);
    let sitemapAdded = 0;
    for (const u of entries) {
      // Count only URLs this strategy actually contributed, so the
      // diagnostics reflect sitemap's own share when collections already
      // added some of the same product URLs.
      if (!urlSet.has(u.loc)) sitemapAdded++;
      urlSet.add(u.loc);
      if (u.lastmod) {
        lastmod.set(u.loc, u.lastmod);
        diagnostics.sitemap.lastmod++;
      }
    }
    diagnostics.sitemap.urls = sitemapAdded;
  } catch (error) {
    diagnostics.sitemap.error = String(error);
  }
  config.onDiscoveryProgress?.({
    phase: "sitemap",
    urlsFound: urlSet.size,
    sitemapUrls: diagnostics.sitemap.urls,
    htmlUrls: 0,
    htmlPagesVisited: 0,
    collectionHandles: diagnostics.collections.reduce(
      (n, c) => n + c.handles,
      0,
    ),
  });

  // 3. HTML link-graph BFS from the site root.
  try {
    const html = await discoverByHtmlCrawl(config.origin, opts, {
      maxPages: DISCOVERY_MAX_PAGES,
      maxDepth: DISCOVERY_MAX_DEPTH,
      onPageVisited: (pagesVisited, productsFound) => {
        config.onDiscoveryProgress?.({
          phase: "htmlCrawl",
          // Approximate live union: urlSet (collections + sitemap) plus the
          // BFS's own raw count. May briefly over-count URLs found by both
          // strategies; the final 'done' tick reports the deduped total.
          urlsFound: urlSet.size + productsFound,
          sitemapUrls: diagnostics.sitemap.urls,
          htmlUrls: productsFound,
          htmlPagesVisited: pagesVisited,
          collectionHandles: diagnostics.collections.reduce(
            (n, c) => n + c.handles,
            0,
          ),
        });
      },
    });
    for (const u of html.productUrls) urlSet.add(u);
    diagnostics.htmlCrawl = {
      urls: html.productUrls.length,
      pagesVisited: html.pagesVisited,
      truncated: html.truncated,
    };
  } catch (error) {
    diagnostics.htmlCrawl.error = String(error);
  }
  config.onDiscoveryProgress?.({
    phase: "done",
    urlsFound: urlSet.size,
    sitemapUrls: diagnostics.sitemap.urls,
    htmlUrls: diagnostics.htmlCrawl.urls,
    htmlPagesVisited: diagnostics.htmlCrawl.pagesVisited,
    collectionHandles: diagnostics.collections.reduce(
      (n, c) => n + c.handles,
      0,
    ),
    platform: diagnostics.platform.platform,
  });

  return {
    urls: [...urlSet].filter((u) => !opts.isAllowed || opts.isAllowed(u)),
    lastmod,
    diagnostics,
  };
}

/** Filters a sitemap's URL set down to product-page entries. */
function filterProductSitemapEntries(urls: DiscoveredUrl[]): DiscoveredUrl[] {
  return urls.filter(
    (u) =>
      /\/products?\/[a-z0-9_-]+/i.test(u.loc) ||
      /\/dp\/[a-z0-9_-]+/i.test(u.loc) ||
      /\/item\/[a-z0-9_-]+/i.test(u.loc),
  );
}

export { httpOptions };
export type { HttpOptions };
