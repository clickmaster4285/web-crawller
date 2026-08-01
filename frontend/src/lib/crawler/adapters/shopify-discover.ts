/**
 * Shopify-specific discovery.
 *
 * Walks paginated collection pages to extract product handles, and exposes
 * a regex for matching `/products/{handle}` URLs (used in dedupe and for
 * filtering sitemap results).
 */

import { fetchText } from "../core/http.ts";
import type { HttpOptions } from "../core/http.ts";

/** Matches a Shopify product URL. Capture group 1 is the handle. */
export const SHOPIFY_PRODUCT_URL_RE = /\/products\/([a-z0-9-]+)/g;

/** Matches a product URL scoped to a specific collection. */
export function collectionProductUrlRe(collection: string): RegExp {
  return new RegExp(
    `/collections/${escapeRegex(collection)}/products/([a-z0-9-]+)`,
    "g",
  );
}

/**
 * Extracts product handles from a Shopify collection page's HTML by matching
 * `/products/{handle}` links scoped to that collection. Falls back to plain
 * `/products/{handle}` links if the collection-scoped ones are missing.
 */
export function extractProductHandles(
  html: string,
  collection?: string,
): string[] {
  const handles = new Set<string>();
  const scoped = collection ? collectionProductUrlRe(collection) : null;
  const plain = SHOPIFY_PRODUCT_URL_RE;

  let match: RegExpExecArray | null;
  if (scoped) {
    while ((match = scoped.exec(html)) !== null) handles.add(match[1]);
  }
  if (handles.size === 0) {
    const plainGlobal = new RegExp(plain.source, "g");
    while ((match = plainGlobal.exec(html)) !== null) handles.add(match[1]);
  }
  return [...handles];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Discovers every product handle in a Shopify collection by walking its
 * (paginated) HTML pages: /collections/{handle}?page=N.
 */
export async function discoverCollectionHandles(
  origin: string,
  collection: string,
  options: HttpOptions,
  maxPages = 20,
): Promise<string[]> {
  const handles = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${origin}/collections/${collection}` + (page > 1 ? `?page=${page}` : "");
    // Respect robots.txt: a disallowed collection page yields nothing anyway.
    if (options.isAllowed && !options.isAllowed(url)) break;
    const html = await fetchText(url, options);
    const found = extractProductHandles(html, collection);
    if (found.length === 0) break;
    found.forEach((h) => handles.add(h));
    // Stop when the page no longer offers a "next" page.
    if (!new RegExp(`page=${page + 1}`).test(html)) break;
  }
  return [...handles];
}
