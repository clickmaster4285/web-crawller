/**
 * Sitemap-driven discovery.
 *
 * Fetches `/sitemap.xml`, follows the sitemap index to child sitemaps, and
 * extracts page URLs. Works for any platform that publishes a sitemap
 * (Shopify, BigCommerce, Magento, most serious stores).
 */

import { fetchText } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";

/** A discovered URL and (when available) its last-modification date. */
export interface DiscoveredUrl {
  loc: string;
  lastmod: string | null;
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

/**
 * Fetches a sitemap document and returns every URL in it. If the document is
 * a sitemap index (its URLs point at other sitemaps), those are resolved
 * recursively with a bounded depth.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: HttpOptions,
  depth = 0,
): Promise<DiscoveredUrl[]> {
  const xml = await fetchText(sitemapUrl, options);
  const locs = extractLocs(xml);

  // A sitemap index has <sitemap><loc> entries; a plain sitemap has
  // <url><loc> entries. Indexes rarely mix URL entries, but we detect it.
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  if (isIndex && depth < 3) {
    const nested: DiscoveredUrl[] = [];
    for (const loc of locs) {
      const child = await fetchSitemapUrls(loc, options, depth + 1);
      nested.push(...child);
    }
    return nested;
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
  return urls;
}

/** Standard sitemap entry points for a site root. */
export function sitemapLocations(origin: string): string[] {
  return [`${origin}/sitemap.xml`];
}
