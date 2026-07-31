const GATEWAY = "https://connector-gateway.lovable.dev/firecrawl/v2";

export type ScrapedProduct = {
  url: string;
  name: string;
  brand: string | null;
  category: string | null;
  sku: string | null;
  gtin: string | null;
  price: number | null;
  currency: string | null;
  stock: "in_stock" | "low_stock" | "out_of_stock" | "unknown";
  imageUrl: string | null;
};

function headers() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const connectionKey = process.env.FIRECRAWL_API_KEY;
  if (!lovableKey || !connectionKey) {
    throw new Error("Crawling is not configured — the Firecrawl connection is missing.");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": connectionKey,
  };
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`Firecrawl ${path} failed [${response.status}]: ${text}`);
    throw new Error(`Crawl request failed [${response.status}]: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

const PRODUCT_HINTS = ["/product", "/products/", "/p/", "/item", "/shop/", "/dp/"];

/** Discover candidate product URLs on a store. */
export async function discoverProductUrls(website: string, limit: number): Promise<string[]> {
  const result = await call<{ links?: Array<string | { url?: string }> }>("/map", {
    url: website,
    search: "product",
    limit: Math.min(Math.max(limit * 4, 50), 500),
    includeSubdomains: false,
  });

  const links = (result.links ?? [])
    .map((l) => (typeof l === "string" ? l : (l?.url ?? "")))
    .filter(Boolean);

  const products = links.filter((l) => PRODUCT_HINTS.some((h) => l.toLowerCase().includes(h)));
  const pool = products.length > 0 ? products : links;

  return Array.from(new Set(pool)).slice(0, limit);
}

const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    brand: { type: "string" },
    category: { type: "string" },
    sku: { type: "string" },
    gtin: { type: "string" },
    price: { type: "number" },
    currency: { type: "string" },
    availability: {
      type: "string",
      description: "One of: in_stock, low_stock, out_of_stock, unknown",
    },
    image_url: { type: "string" },
  },
  required: ["name"],
} as const;

type ScrapeResponse = {
  json?: Record<string, unknown>;
  data?: { json?: Record<string, unknown>; metadata?: { title?: string } };
  metadata?: { title?: string };
};

function normaliseStock(value: unknown): ScrapedProduct["stock"] {
  const v = String(value ?? "").toLowerCase();
  if (v.includes("out") || v.includes("sold")) return "out_of_stock";
  if (v.includes("low") || v.includes("limited") || v.includes("few")) return "low_stock";
  if (v.includes("in") || v.includes("available")) return "in_stock";
  return "unknown";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return v.length > 0 ? v : null;
}

/** Scrape one product page into a structured product record. */
export async function scrapeProduct(url: string): Promise<ScrapedProduct | null> {
  try {
    const result = await call<ScrapeResponse>("/scrape", {
      url,
      onlyMainContent: true,
      formats: [
        {
          type: "json",
          schema: PRODUCT_SCHEMA,
          prompt:
            "Extract the single product sold on this page: name, brand, category, sku, gtin, numeric price, currency code, availability and main image URL.",
        },
      ],
    });

    const json = result.json ?? result.data?.json;
    if (!json) return null;

    const name = str(json.name) ?? str(result.metadata?.title ?? result.data?.metadata?.title);
    if (!name) return null;

    return {
      url,
      name,
      brand: str(json.brand),
      category: str(json.category),
      sku: str(json.sku),
      gtin: str(json.gtin),
      price: toNumber(json.price),
      currency: str(json.currency),
      stock: normaliseStock(json.availability),
      imageUrl: str(json.image_url),
    };
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return null;
  }
}

/** Scrape a batch of product pages with limited concurrency. */
export async function scrapeProducts(urls: string[], concurrency = 4): Promise<ScrapedProduct[]> {
  const results: ScrapedProduct[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const index = cursor++;
      const product = await scrapeProduct(urls[index]);
      if (product) results.push(product);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}
