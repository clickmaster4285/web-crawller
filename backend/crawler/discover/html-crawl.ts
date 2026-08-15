/**
 * HTML link-graph BFS discovery.
 *
 * Starts at the site root, follows links that look like category / nav
 * anchors, and collects URLs that look like product pages. Used as a
 * complement to sitemap.xml discovery for stores that don't publish a
 * sitemap or where the sitemap is incomplete.
 *
 * Heuristics (no DOM — pure regex over HTML):
 *   - Category-ish link paths: /category, /collection(s), /shop, /catalog,
 *     /product-category (WooCommerce), ?product_cat= filters
 *   - Product-ish link paths: /product(s), /p, /dp, /item, and WooCommerce
 *     /shop/<cat>/<product>/ permalinks (two segments after /shop/)
 *   - Anchor extraction: <a href="...">
 *
 * Hard caps to keep it bounded:
 *   - maxPages: total HTML pages to fetch (default 60)
 *   - maxDepth: BFS depth from root (default 3)
 *   - same-origin only
 */

import { fetchText } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";
import { waitForControl, type CrawlControl } from "../core/control.ts";

// Category-ish paths: WooCommerce `/product-category/` (its category base),
// `?product_cat=` filters, and the classic /category|collections|shop|catalog
// patterns. `/shop/` itself (and `/shop/<one-segment>/`) is a category
// archive candidate — but see PRODUCT_BARE_RE for multi-segment /shop/ URLs.
const CATEGORY_RE =
  /\/product-category\/|[?&]product_cat=|\/(category|categories|collection|collections|shop|catalog)(\/|\?|#|$)/i;
const PRODUCT_RE = /\/(product|products|item|dp|p)\/[a-z0-9_-]+/i;
// WooCommerce permalink-with-category product URLs: `/shop/<cat>/<product>/`
// (two or more segments after /shop/). Single-segment `/shop/<slug>/` stays a
// category candidate — those are archives, not products, on most setups.
const PRODUCT_BARE_RE = /\/shop\/(?:[a-z0-9_-]+\/)+[a-z0-9_-]+/i;

const ANCHOR_RE = /<a\s+[^>]*href=["']([^"'#]+)["']/gi;

export interface HtmlCrawlOptions {
  /** Max HTML pages to fetch across the whole BFS. */
  maxPages?: number;
  /** Max BFS depth from the start URL. */
  maxDepth?: number;
  /** Called after each page is visited (live progress during the BFS). */
  onPageVisited?: (pagesVisited: number, productsFound: number) => void;
  /**
   * Cooperative pause/cancel handle — checked between pages so a cancel
   * lands during the BFS, not only after it finishes.
   */
  control?: CrawlControl;
}

export interface HtmlCrawlResult {
  productUrls: string[];
  pagesVisited: number;
  truncated: boolean;
}

/**
 * Performs a BFS starting at `startUrl` and returns discovered product URLs.
 * Product URLs are returned absolute; only same-origin links are followed.
 */
export async function discoverByHtmlCrawl(
  startUrl: string,
  options: HttpOptions,
  crawlOptions: HtmlCrawlOptions = {},
): Promise<HtmlCrawlResult> {
  const origin = new URL(startUrl).origin;
  const maxPages = crawlOptions.maxPages ?? 60;
  const maxDepth = crawlOptions.maxDepth ?? 3;

  const visited = new Set<string>();
  const products = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: startUrl, depth: 0 },
  ];
  let pagesVisited = 0;
  let truncated = false;

  // Pages fetched in parallel waves of 6 (politeness still throttles every
  // request) — the old one-page-at-a-time BFS serialized a whole storefront.
  // `pagesVisited` counts attempts (same semantics as the sequential loop:
  // every page the BFS decided to fetch), so the maxPages cap still bounds
  // total work. Set-membership checks run synchronously before any await, so
  // a URL duplicated inside one wave can never be fetched twice.
  const CONCURRENCY = 6;
  while (queue.length > 0 && pagesVisited < maxPages) {
    await waitForControl(crawlOptions.control);
    const batch: Array<{ url: string; depth: number }> = [];
    while (
      queue.length > 0 &&
      batch.length < CONCURRENCY &&
      pagesVisited + batch.length < maxPages
    ) {
      batch.push(queue.shift()!);
    }
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        if (visited.has(url)) return;
        visited.add(url);
        // Respect robots.txt: don't fetch pages robots disallows (marked
        // visited above so a disallowed link isn't re-examined if
        // re-enqueued).
        if (options.isAllowed && !options.isAllowed(url)) return;
        pagesVisited++;

        let html: string;
        try {
          html = await fetchText(url, options);
        } catch {
          return;
        }

        for (const href of extractAnchors(html)) {
          const abs = toAbsolute(href, url, origin);
          if (!abs) continue;
          // Respect robots.txt: don't collect disallowed product URLs either.
          if (options.isAllowed && !options.isAllowed(abs)) continue;

          if (isProductUrl(abs)) {
            products.add(abs);
            continue;
          }

          if (depth < maxDepth && !visited.has(abs) && isCategoryUrl(abs)) {
            queue.push({ url: abs, depth: depth + 1 });
          }
        }
        // Live progress tick after this page is fully parsed.
        crawlOptions.onPageVisited?.(pagesVisited, products.size);
      }),
    );
  }

  if (queue.length > 0) truncated = true;

  return {
    productUrls: [...products],
    pagesVisited,
    truncated,
  };
}

function extractAnchors(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = m[1];
    if (href) out.push(href);
  }
  return out;
}

function toAbsolute(href: string, base: string, origin: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.origin !== origin) return null;
    // Strip hash; keep query (some category pages are paginated via ?page=).
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function isCategoryUrl(url: string): boolean {
  return CATEGORY_RE.test(url);
}

function isProductUrl(url: string): boolean {
  if (PRODUCT_RE.test(url)) return true;
  if (PRODUCT_BARE_RE.test(url)) return true;
  return false;
}
