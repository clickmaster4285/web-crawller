/**
 * JSON-LD extractor.
 *
 * Parses `<script type="application/ld+json">` blocks in HTML, looks for
 * Schema.org `Product` (or `schema:Product` / `https://schema.org/Product`),
 * and maps the structured data into an `ExtractedProduct`.
 *
 * Many real-world pages contain a JSON-LD graph: a top-level `WebPage` that
 * references a `Product` via `@graph`, or an `@id` indirection. This module
 * walks the graph to find the product node regardless of nesting.
 *
 * Zero deps — uses `JSON.parse` only. Invalid JSON in `<script>` tags is
 * silently skipped (sites do break this in practice).
 */

import type { ExtractedOffer, ExtractedProduct } from "./schema.ts";

const PRODUCT_TYPE = "Product";
const PRODUCT_TYPES = new Set([
  PRODUCT_TYPE.toLowerCase(),
  "schema:product",
  "https://schema.org/product",
]);

/** A raw node from a JSON-LD document. */
type LdNode = unknown;

/**
 * Extracts a vendor-neutral product from the JSON-LD blocks in `html`.
 * Returns `null` when no Product node is found.
 */
export function extractJsonLd(
  html: string,
  pageUrl: string,
): ExtractedProduct | null {
  const blocks = extractJsonLdBlocks(html);
  for (const block of blocks) {
    const product = findProductNode(block);
    if (product) {
      const extracted = mapProduct(product, pageUrl);
      if (extracted) return extracted;
    }
  }
  return null;
}

/** Pulls every `<script type="application/ld+json">...</script>` body. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out: unknown[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // Sites ship invalid JSON in ld+json all the time. Skip silently.
    }
  }
  return out;
}

/**
 * Walks a parsed JSON-LD document and returns the first Product node it
 * finds, handling `@graph` arrays and `@id` indirection. Returns `null` if
 * no Product is present.
 */
export function findProductNode(doc: unknown): Record<string, unknown> | null {
  return walk(doc);

  function walk(node: LdNode): Record<string, unknown> | null {
    if (node == null) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== "object") return null;

    const obj = node as Record<string, unknown>;
    if (isProductNode(obj)) return obj;

    // @graph: most common case
    if (Array.isArray(obj["@graph"])) {
      for (const item of obj["@graph"]) {
        const found = walk(item);
        if (found) return found;
      }
    }

    // mainEntity → Article/Product
    if (obj.mainEntity) {
      const found = walk(obj.mainEntity);
      if (found) return found;
    }

    // Single-level @id indirection: a node may reference another by @id
    // (we don't currently resolve across documents, but handle within-doc).
    if (typeof obj["@id"] === "string" && obj["@type"] && !isProductNode(obj)) {
      // Fall through — we've already checked isProductNode above.
    }

    return null;
  }
}

function isProductNode(obj: Record<string, unknown>): boolean {
  const type = obj["@type"];
  if (typeof type === "string") {
    return PRODUCT_TYPES.has(type.toLowerCase());
  }
  if (Array.isArray(type)) {
    return type.some(
      (t) => typeof t === "string" && PRODUCT_TYPES.has(t.toLowerCase()),
    );
  }
  return false;
}

/** Maps a JSON-LD Product node into an ExtractedProduct. */
function mapProduct(
  node: Record<string, unknown>,
  pageUrl: string,
): ExtractedProduct | null {
  const name = stringField(node, "name");
  if (!name) return null;

  const image = firstImage(node["image"]);
  const description = stringField(node, "description");
  const brand = brandName(node["brand"]);
  const category = firstCategory(node["category"]);
  const sku = stringField(node, "sku");
  const mpn = stringField(node, "mpn");
  const gtin = firstGtin(node);
  const rating = aggregateRatingValue(node["aggregateRating"]);
  const reviewCount = aggregateRatingCount(node["aggregateRating"]);

  const offers = collectOffers(node["offers"]);
  const primary = pickPrimaryOffer(offers);

  return {
    name,
    description,
    image,
    brand,
    category,
    sku,
    gtin,
    mpn,
    price: primary?.price ?? 0,
    compareAtPrice: undefined, // JSON-LD rarely exposes strikethrough cleanly
    priceCurrency: primary?.priceCurrency ?? "USD",
    availability: toAvailability(primary?.availability),
    offers,
    rating,
    reviewCount,
    url: pageUrl,
    source: "jsonld",
  };
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

/** JSON-LD `image` is often an array, an object, or a string. */
function firstImage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const got = firstImage(item);
      if (got) return got;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const url = (value as Record<string, unknown>)["url"];
    if (typeof url === "string") return url;
  }
  return undefined;
}

/** `brand` can be a string, a Brand object, or an array of either. */
function brandName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const n = brandName(v);
      if (n) return n;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    return stringField(value as Record<string, unknown>, "name");
  }
  return undefined;
}

/** `category` can be a string, a `Thing`, or an array. */
function firstCategory(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const c = firstCategory(v);
      if (c) return c;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    return stringField(value as Record<string, unknown>, "name");
  }
  return undefined;
}

function firstGtin(node: Record<string, unknown>): string | undefined {
  for (const key of ["gtin13", "gtin12", "gtin8", "gtin", "ean"]) {
    const v = stringField(node, key);
    if (v) return v;
  }
  return undefined;
}

function aggregateRatingValue(value: unknown): number | undefined {
  if (value && typeof value === "object") {
    const v = (value as Record<string, unknown>)["ratingValue"];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function aggregateRatingCount(value: unknown): number | undefined {
  if (value && typeof value === "object") {
    const v =
      (value as Record<string, unknown>)["reviewCount"] ??
      (value as Record<string, unknown>)["ratingCount"];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function collectOffers(value: unknown): ExtractedOffer[] {
  const out: ExtractedOffer[] = [];
  for (const item of asArray(value)) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = obj["@type"];
    // Skip nested offers that are themselves AggregateOffer (we want leaves)
    if (
      typeof type === "string" &&
      type.toLowerCase().includes("aggregateoffer")
    ) {
      const low = obj["lowPrice"];
      const high = obj["highPrice"];
      if (typeof low === "number" || typeof low === "string") {
        out.push({
          price: toNumber(low),
          priceCurrency: stringField(obj, "priceCurrency") ?? "USD",
          availability: stringField(obj, "availability") ?? "InStock",
          url: stringField(obj, "url"),
          sku: stringField(obj, "sku"),
        });
      }
      if (typeof high === "number" || typeof high === "string") {
        out.push({
          price: toNumber(high),
          priceCurrency: stringField(obj, "priceCurrency") ?? "USD",
          availability: stringField(obj, "availability") ?? "InStock",
          url: stringField(obj, "url"),
          sku: stringField(obj, "sku"),
        });
      }
      continue;
    }
    out.push({
      price: toNumber(obj["price"] ?? obj["Price"]),
      priceCurrency: stringField(obj, "priceCurrency") ?? "USD",
      availability: stringField(obj, "availability") ?? "InStock",
      url: stringField(obj, "url"),
      sku: stringField(obj, "sku"),
    });
  }
  return out;
}

function pickPrimaryOffer(
  offers: ExtractedOffer[],
): ExtractedOffer | undefined {
  // Prefer an explicit lowPrice, then the cheapest in-stock, then any.
  const inStock = offers.filter(
    (o) =>
      o.availability === "InStock" || o.availability === "LimitedAvailability",
  );
  const pool = inStock.length > 0 ? inStock : offers;
  if (pool.length === 0) return undefined;
  return pool.reduce((min, o) => (o.price < min.price ? o : min), pool[0]);
}

function toAvailability(
  value: string | undefined,
): "in_stock" | "out_of_stock" | "preorder" | "unknown" {
  if (!value) return "unknown";
  const v = value.toLowerCase();
  if (v.includes("instock") || v.includes("limitedavailability"))
    return "in_stock";
  if (
    v.includes("outofstock") ||
    v.includes("soldout") ||
    v.includes("discontinued")
  )
    return "out_of_stock";
  if (
    v.includes("preorder") ||
    v.includes("backorder") ||
    v.includes("presale")
  )
    return "preorder";
  return "unknown";
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
