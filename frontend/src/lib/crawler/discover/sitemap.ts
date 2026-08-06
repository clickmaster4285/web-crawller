/**
 * Sitemap-driven discovery.
 *
 * Fetches sitemaps and extracts page URLs. Works for any platform that
 * publishes a sitemap (Shopify, BigCommerce, Magento, WordPress/Rank Math,
 * most serious stores).
 *
 * Discovery is **multi-candidate**: a site may not serve `/sitemap.xml`
 * directly (it can 301/302-redirect to the homepage, as WordPress sites do),
 * so candidates are tried in order:
 *   1. Every `Sitemap:` URL declared in robots.txt (Rank Math/Yoast declare
 *      `sitemap_index.xml` + `product-sitemap.xml` there).
 *   2. `/sitemap.xml` (the conventional location).
 *   3. `/sitemap_index.xml` (the WordPress/Rank Math index location).
 * The first candidate that yields XML sitemap data wins; an HTML response
 * (redirect to a page) is detected and skipped, not treated as an empty
 * sitemap.
 */

import { fetchText } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";
import { runWithConcurrency } from "../core/queue.ts";
import { waitForControl, type CrawlControl } from "../core/control.ts";

/** A discovered URL and (when available) its last-modification date. */
export interface DiscoveredUrl {
  loc: string;
  lastmod: string | null;
}

/** Source of a sitemap candidate (for diagnostics + the verbose UI). */
export type SitemapCandidateSource = "robots.txt" | "default";

export interface SitemapCandidate {
  url: string;
  source: SitemapCandidateSource;
}

/** Outcome of fetching one sitemap candidate (recorded in diagnostics). */
export interface SitemapCandidateResult {
  url: string;
  source: SitemapCandidateSource;
  /** "ok" — XML parsed; "html" — responded with HTML (redirect to a page);
   *  "error" — fetch/parse threw. */
  status: "ok" | "html" | "error";
  /** Total <loc> entries found (all types). */
  urls: number;
  /** URLs that matched product-page patterns after filtering. */
  productUrls: number;
  /** True when every URL came from a known product sitemap (e.g. WordPress
   *  `wp-sitemap-posts-product-*`), so the caller should trust them as
   *  products instead of pattern-filtering them out. */
  isProductSitemap?: boolean;
  /** Parsed URLs (available when status === "ok") — avoids a second fetch. */
  entries?: DiscoveredUrl[];
  error?: string;
}

/** Result of walking one sitemap document (or an index's children). */
export interface SitemapFetchResult {
  entries: DiscoveredUrl[];
  /** True when every entry came from a known product sitemap. */
  productOnly: boolean;
}

// `[^\s\r]+` (not `\S+`) so a trailing `\r` on CRLF robots.txt files can't
// corrupt the captured URL.
const SITEMAP_DIRECTIVE_RE = /^\s*[Ss]itemap:\s*([^\s\r]+)/gm;

/** Extracts every `Sitemap:` URL from a robots.txt body. */
export function robotsSitemaps(
  robotsBody: string | null | undefined,
): string[] {
  if (!robotsBody) return [];
  const out: string[] = [];
  for (const m of robotsBody.matchAll(SITEMAP_DIRECTIVE_RE)) {
    const url = m[1]?.trim();
    if (url) out.push(url);
  }
  return out;
}

/** Child sitemap names that never contain product pages (skip in index walks). */
const NON_PRODUCT_SITEMAP_RE =
  /(image|images|media|attachment|video|news-sitemap|news)/i;

/**
 * Children of a WordPress core sitemap index that never hold products — the
 * blog/page/attachment post-type sitemaps, taxonomy sitemaps and the users
 * sitemap. The negative lookahead keeps `wp-sitemap-posts-product-*` (and
 * other product post types) in the walk.
 */
const WORDPRESS_NON_PRODUCT_CHILD_RE =
  /wp-sitemap-(posts-(?!product-)|taxonomies-|users-|authors-)/i;

/** True when a sitemap URL looks like a non-product sitemap (images, media…). */
export function isNonProductSitemap(url: string): boolean {
  return NON_PRODUCT_SITEMAP_RE.test(url);
}

/**
 * True when a sitemap URL is a *known product sitemap* — WordPress core's
 * `wp-sitemap-posts-product-*.xml`, Rank Math's `product-sitemap.xml`, or
 * similarly-named files. Every URL in these is a product, regardless of how
 * the product URLs happen to look (e.g. WooCommerce `/shop/<cat>/<slug>/`
 * permalinks that no generic pattern can safely classify).
 */
export function isProductSitemap(url: string): boolean {
  return /wp-sitemap-posts-product-|product-sitemap|products?[-_.]sitemap|sitemap[-_.]products?/i.test(
    url,
  );
}

/**
 * Ordered sitemap candidates for an origin: robots.txt-declared sitemaps
 * first (deduped), then `/sitemap.xml`, then `/sitemap_index.xml`.
 */
export function sitemapCandidates(
  origin: string,
  robotsBody?: string | null,
): SitemapCandidate[] {
  const seen = new Set<string>();
  const out: SitemapCandidate[] = [];
  for (const url of robotsSitemaps(robotsBody)) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ url, source: "robots.txt" });
    }
  }
  // Strip a trailing slash so `https://store.com//sitemap.xml` (a common
  // double-slash from origins typed with a trailing `/`) never happens.
  const root = origin.replace(/\/+$/, "");
  for (const url of [`${root}/sitemap.xml`, `${root}/sitemap_index.xml`]) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ url, source: "default" });
    }
  }
  return out;
}

/** Extracts every <loc> value from a sitemap document. */
export function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>(?:<!\[CDATA\[)?([^<\]\s]+)(?:\]\]>)?<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    locs.push(match[1].trim());
  }
  return locs;
}

/** True when the fetched body is XML (a sitemap), not an HTML page. */
export function isSitemapXml(body: string): boolean {
  const head = body.slice(0, 1024).trimStart().toLowerCase();
  return (
    head.startsWith("<?xml") ||
    head.startsWith("<urlset") ||
    head.startsWith("<sitemapindex") ||
    head.includes("<url>") ||
    head.includes("<loc>")
  );
}

/**
 * Fetches a sitemap document and returns every URL in it. If the document is
 * a sitemap index (its URLs point at other sitemaps), those are resolved
 * recursively with a bounded depth, skipping obvious non-product children
 * (images/media/news sitemaps) so a product crawl isn't bloated by them.
 *
 * `prefetchedXml` lets callers that already fetched the document (e.g. to
 * check whether it's XML) avoid a second request.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: HttpOptions,
  depth = 0,
  prefetchedXml?: string,
  control?: CrawlControl,
): Promise<SitemapFetchResult> {
  const xml = prefetchedXml ?? (await fetchText(sitemapUrl, options));
  const locs = extractLocs(xml);

  // A sitemap index has <sitemap><loc> entries; a plain sitemap has
  // <url><loc> entries. Indexes rarely mix URL entries, but we detect it.
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  if (isIndex && depth < 3) {
    // Children that can actually hold products — skip images/media/news and
    // WordPress core sitemap files for posts, pages, taxonomies, users… so a
    // product crawl isn't bloated with 100s of irrelevant URLs.
    const retained = locs.filter(
      (loc) =>
        !isNonProductSitemap(loc) && !WORDPRESS_NON_PRODUCT_CHILD_RE.test(loc),
    );
    // Fetch index children in parallel (bounded at 6 in flight — the
    // politeness throttle still gates every request, so this stays polite):
    // a 23-child index like athletix.ae's was the sequential bottleneck that
    // made discovery drag on for minutes. Each child checks the control
    // handle so pause/cancel also work during the walk.
    const nested: DiscoveredUrl[] = [];
    await runWithConcurrency(
      retained,
      Math.min(6, retained.length),
      async (loc) => {
        await waitForControl(control);
        const child = await fetchSitemapUrls(
          loc,
          options,
          depth + 1,
          undefined,
          control,
        );
        nested.push(...child.entries);
      },
    );
    // Trust the entries as products only when *every* retained child is a
    // known product sitemap. A mixed index (e.g. Rank Math's
    // `sitemap_index.xml` listing product-sitemap.xml + page-sitemap.xml)
    // falls back to the caller's URL-pattern filter so pages don't leak in.
    const productOnly =
      retained.length > 0 && retained.every((loc) => isProductSitemap(loc));
    return { entries: nested, productOnly };
  }

  // Plain sitemap: pair <loc> with its sibling <lastmod>.
  const urls: DiscoveredUrl[] = [];
  const blockRe = /<url>[\s\S]*?<\/url>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const loc = block[0].match(
      /<loc>(?:<!\[CDATA\[)?([^<\]\s]+)(?:\]\]>)?<\/loc>/,
    )?.[1];
    const lastmod = block[0].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    if (loc) urls.push({ loc: loc.trim(), lastmod: lastmod?.trim() ?? null });
  }
  return { entries: urls, productOnly: isProductSitemap(sitemapUrl) };
}

/**
 * Fetches a sitemap candidate and reports its outcome. Detects an HTML
 * response (a redirect to a page, e.g. /sitemap.xml → homepage) so the
 * discovery loop can move on to the next candidate instead of silently
 * recording "0 URLs". When the document is XML, the parsed URLs are
 * returned in `entries` so the caller doesn't have to fetch it again.
 */
export async function fetchSitemapCandidate(
  candidate: SitemapCandidate,
  options: HttpOptions,
  control?: CrawlControl,
): Promise<SitemapCandidateResult> {
  const result: SitemapCandidateResult = {
    url: candidate.url,
    source: candidate.source,
    status: "ok",
    urls: 0,
    productUrls: 0,
  };
  let xml: string;
  try {
    xml = await fetchText(candidate.url, options);
  } catch (error) {
    result.status = "error";
    result.error = String(error);
    return result;
  }
  if (!isSitemapXml(xml)) {
    result.status = "html";
    return result;
  }
  let all: SitemapFetchResult;
  try {
    // Pass the body we already fetched — no second request for the candidate.
    all = await fetchSitemapUrls(candidate.url, options, 0, xml, control);
  } catch (error) {
    result.status = "error";
    result.error = String(error);
    return result;
  }
  result.urls = all.entries.length;
  result.productUrls = all.entries.filter((u) =>
    /^https?:\/\//i.test(u.loc),
  ).length;
  result.isProductSitemap = all.productOnly;
  result.entries = all.entries;
  return result;
}
