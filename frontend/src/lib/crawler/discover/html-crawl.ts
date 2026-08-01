/**
 * HTML link-graph BFS discovery.
 *
 * Starts at the site root, follows links that look like category / nav
 * anchors, and collects URLs that look like product pages. Used as a
 * complement to sitemap.xml discovery for stores that don't publish a
 * sitemap or where the sitemap is incomplete.
 *
 * Heuristics (no DOM — pure regex over HTML):
 *   - Category-ish link paths: /category, /categories, /c, /collection,
 *     /collections, /shop, /products, /catalog
 *   - Product-ish link paths: /product, /p, /dp, /item, /products
 *   - Anchor extraction: <a href="...">
 *
 * Hard caps to keep it bounded:
 *   - maxPages: total HTML pages to fetch (default 60)
 *   - maxDepth: BFS depth from root (default 3)
 *   - same-origin only
 */

import { fetchText } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";

const CATEGORY_RE =
  /\/(category|categories|collection|collections|shop|catalog)(\/|\?|#|$)/i;
const PRODUCT_RE = /\/(product|products|item|dp|p)\/[a-z0-9_-]+/i;
const PRODUCT_BARE_RE = /\/(product|item)\/[a-z0-9_-]+/i;

const ANCHOR_RE = /<a\s+[^>]*href=["']([^"'#]+)["']/gi;

export interface HtmlCrawlOptions {
  /** Max HTML pages to fetch across the whole BFS. */
  maxPages?: number;
  /** Max BFS depth from the start URL. */
  maxDepth?: number;
  /** Called after each page is visited (live progress during the BFS). */
  onPageVisited?: (pagesVisited: number, productsFound: number) => void;
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

  while (queue.length > 0 && pagesVisited < maxPages) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    // Respect robots.txt: don't fetch pages robots disallows (marked visited
    // above so a disallowed link isn't re-examined if re-enqueued).
    if (options.isAllowed && !options.isAllowed(url)) continue;
    pagesVisited++;

    let html: string;
    try {
      html = await fetchText(url, options);
    } catch {
      continue;
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
