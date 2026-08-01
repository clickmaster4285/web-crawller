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
): Promise<ProductDiscovery> {
  const urlSet = new Set<string>();
  const lastmod = new Map<string, string>();
  const diagnostics: ProductDiscovery["diagnostics"] = {
    collections: [],
    sitemap: { urls: 0, lastmod: 0 },
    htmlCrawl: { urls: 0, pagesVisited: 0, truncated: false },
  };

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
    }
  }

  // 2. Sitemap walk (any platform).
  try {
    const sitemapUrls = await fetchSitemapUrls(
      `${config.origin}/sitemap.xml`,
      opts,
    );
    for (const u of filterProductSitemapEntries(sitemapUrls)) {
      urlSet.add(u.loc);
      if (u.lastmod) {
        lastmod.set(u.loc, u.lastmod);
        diagnostics.sitemap.lastmod++;
      }
    }
    diagnostics.sitemap.urls = urlSet.size;
  } catch (error) {
    diagnostics.sitemap.error = String(error);
  }

  // 3. HTML link-graph BFS from the site root.
  try {
    const html = await discoverByHtmlCrawl(config.origin, opts, {
      maxPages: DISCOVERY_MAX_PAGES,
      maxDepth: DISCOVERY_MAX_DEPTH,
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
