/**
 * Shopify product parsing.
 *
 * The OB Designs store is a Shopify storefront. Its /products/{handle}.json
 * endpoint returns the full product object with variants. We map that into
 * the vendor-neutral `CrawledProduct` shape.
 *
 * Reference shape (Shopify product JSON):
 *   {
 *     product: {
 *       id, title, body_html, vendor, product_type, handle,
 *       created_at, updated_at, tags: "a, b, c", images: [{ src }],
 *       variants: [{ id, title, sku, price, compare_at_price,
 *                    inventory_policy, inventory_quantity, barcode }]
 *     }
 *   }
 */

import type { CrawledProduct, CrawledVariant } from "../core/types.ts";

interface RawVariant {
  id: number;
  title: string;
  sku: string | null;
  price: string | null;
  compare_at_price: string | null;
  inventory_policy: string | null;
  inventory_quantity: number | null;
  barcode: string | null;
}

export interface RawProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  created_at: string;
  updated_at: string;
  tags: string;
  images?: Array<{ src?: string }> | null;
  variants?: RawVariant[] | null;
}

function toNumber(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toPrice(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A Shopify variant is available if it has positive inventory, or if its
 * inventory policy is "continue" (sell regardless of count) — the closest
 * approximation to on-sale stock this API exposes.
 */
function variantAvailable(variant: RawVariant): boolean {
  if ((variant.inventory_quantity ?? 0) > 0) return true;
  return variant.inventory_policy === "continue";
}

/** Parses a raw Shopify product payload into a CrawledProduct. */
export function parseShopifyProduct(
  raw: RawProduct,
  origin: string,
): CrawledProduct {
  const variants: CrawledVariant[] = (raw.variants ?? []).map((v) => ({
    id: v.id,
    title: v.title,
    sku: v.sku ?? "",
    price: toPrice(v.price),
    compareAtPrice: toPrice(v.compare_at_price) || null,
    available: variantAvailable(v),
    inventoryQuantity: v.inventory_quantity ?? 0,
    barcode: v.barcode ?? "",
  }));

  const priced = variants.filter((v) => v.price > 0);
  const availableVariants = variants.filter((v) => v.available);
  const compareAtPrices = variants
    .map((v) => v.compareAtPrice)
    .filter((p): p is number => p !== null && p > 0);

  return {
    id: raw.id,
    handle: raw.handle,
    url: `${origin}/products/${raw.handle}`,
    name: raw.title,
    brand: raw.vendor ?? "",
    category: raw.product_type ?? "",
    description: raw.body_html ?? "",
    tags: raw.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    image: raw.images?.[0]?.src ?? null,
    price: priced.length ? Math.min(...priced.map((v) => v.price)) : 0,
    compareAtPrice: compareAtPrices.length
      ? Math.min(...compareAtPrices)
      : null,
    available: availableVariants.length > 0,
    variants,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    crawledAt: new Date().toISOString(),
  };
}
