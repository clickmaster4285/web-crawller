/**
 * OpenGraph / product meta-tag extractor (Tier 3, fallback).
 *
 * Reads `<meta property="og:title">`, `og:image`, `og:description`, and the
 * product-namespace price tags:
 *   - product:price:amount
 *   - product:price:currency
 *   - product:availability
 *
 * Used when JSON-LD is missing. Often present alongside microdata.
 */

import type { ExtractedProduct } from "./schema.ts";

const META_RE = /<meta\s+[^>]*>/gi;
const PROP_RE = /property=["']([^"']+)["']/i;
const NAME_RE = /name=["']([^"']+)["']/i;
const CONTENT_RE = /content=["']([^"']*)["']/i;

export function extractOpenGraph(
  html: string,
  pageUrl: string,
): ExtractedProduct | null {
  const tags: Record<string, string> = {};
  for (const m of html.matchAll(META_RE)) {
    const tag = m[0];
    const prop = tag.match(PROP_RE)?.[1] ?? tag.match(NAME_RE)?.[1];
    const content = tag.match(CONTENT_RE)?.[1];
    if (prop && content !== undefined) {
      tags[prop.toLowerCase()] = content;
    }
  }

  const name = tags["og:title"] ?? tags["twitter:title"];
  const image = tags["og:image"];
  const description = tags["og:description"] ?? tags["description"];
  if (!name) return null;

  const priceStr = tags["product:price:amount"] ?? tags["og:price:amount"];
  const currency =
    tags["product:price:currency"] ?? tags["og:price:currency"] ?? "USD";
  const availability = tags["product:availability"] ?? tags["og:availability"];

  // Aug 2026 (activefitnessstore): og:title is NOT a price. Returning a
  // product with price 0 here SHADOWS the HTML heuristics that could find
  // the real JS-rendered price — only produce a product when an actual
  // price tag exists (fall through to the lower tiers otherwise).
  if (!priceStr) return null;
  const price = Number(priceStr);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    name,
    description,
    image,
    price,
    priceCurrency: currency,
    availability: normalizeAvailability(availability),
    offers: [
      {
        price,
        priceCurrency: currency,
        availability: availability ?? "InStock",
        url: pageUrl,
      },
    ],
    url: pageUrl,
    source: "opengraph",
  };
}

function normalizeAvailability(
  value: string | undefined,
): "in_stock" | "out_of_stock" | "preorder" | "unknown" {
  if (!value) return "unknown";
  const v = value.toLowerCase();
  if (v.includes("instock")) return "in_stock";
  if (v.includes("outofstock") || v.includes("soldout")) return "out_of_stock";
  if (v.includes("preorder") || v.includes("backorder")) return "preorder";
  return "unknown";
}
