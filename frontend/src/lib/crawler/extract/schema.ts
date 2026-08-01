/**
 * Extracted (vendor-neutral) product shape.
 *
 * Output of the `extract/*` modules and input to the mapping that turns it
 * into a `CrawledProduct`. Intentionally narrower than CrawledProduct —
 * captures only what structured data / OG / heuristics can reliably surface.
 * Variant-level fidelity is deliberately sacrificed here; it lives in the
 * adapter (Shopify etc.).
 */

export interface ExtractedOffer {
  price: number;
  priceCurrency: string;
  availability:
    | "InStock"
    | "OutOfStock"
    | "PreOrder"
    | "SoldOut"
    | "LimitedAvailability"
    | "Discontinued"
    | "BackOrder"
    | "PreSale"
    | string;
  url?: string;
  sku?: string;
}

export interface ExtractedProduct {
  name: string;
  description?: string;
  image?: string;
  brand?: string;
  category?: string;
  sku?: string;
  gtin?: string; // GTIN-13 / GTIN-12 / EAN
  mpn?: string;
  price: number;
  compareAtPrice?: number;
  priceCurrency: string;
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  offers: ExtractedOffer[];
  rating?: number;
  reviewCount?: number;
  url: string;
  /** Source of truth for debugging — which extractor produced this. */
  source: "jsonld" | "microdata" | "opengraph" | "html-heuristics";
}
