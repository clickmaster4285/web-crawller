import type { SavedCrawlProduct } from "@/lib/api";

/**
 * A stable key for matching a product across stores: normalized lowercase
 * name when present, else the URL's last path segment (slug), else the URL.
 */
export function productKey(p: Pick<SavedCrawlProduct, "name" | "url">): string {
  const name = (p.name ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  if (name) return `n:${name}`;
  try {
    const parts = new URL(p.url).pathname
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean);
    const slug = parts[parts.length - 1] ?? "";
    if (slug) return `s:${slug.toLowerCase()}`;
  } catch {
    // Fall through to the raw URL key.
  }
  return `u:${p.url}`;
}

export interface StoreMatch {
  key: string;
  a: SavedCrawlProduct;
  b: SavedCrawlProduct;
  /** b.price - a.price (positive = store B charges more). */
  priceDiff: number;
  /** True when this pair matched approximately (fuzzy name similarity). */
  fuzzy: boolean;
  /** 0..1 similarity score for fuzzy matches (undefined for exact ones). */
  similarity?: number;
}

export interface StoreComparison {
  matched: StoreMatch[];
  onlyA: SavedCrawlProduct[];
  onlyB: SavedCrawlProduct[];
  /** Matched pairs whose price differs between the two stores. */
  priceChangedCount: number;
}

export interface CompareOptions {
  /**
   * Also match near-identical product names (not just exact name / URL slug
   * matches) using normalized-name similarity.
   */
  fuzzy?: boolean;
  /**
   * Minimum similarity (0..1) for a fuzzy pair to count as a match. Defaults
   * to 0.8 — lower is looser (more matches), higher is stricter.
   */
  fuzzyThreshold?: number;
}

/** Minimum similarity (0..1) for two names to count as the same product. */
const FUZZY_THRESHOLD = 0.8;
/** Rough length budget for edit-distance candidates (bounds the O(n·m) pass). */
const FUZZY_LEN_BUDGET = 15;

/** Normalizes a product name for fuzzy comparison (lowercase, punctuation → space). */
function fuzzyName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token overlap (Jaccard index) of two normalized names. */
function jaccard(a: string, b: string): number {
  const tokensA = new Set(a.split(" "));
  const tokensB = new Set(b.split(" "));
  let inter = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) inter++;
  }
  const union = tokensA.size + tokensB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Classic Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * 0..1 similarity between two normalized names: equality, token overlap,
 * substring containment (one store appends a colour/size, e.g. "… – black"),
 * then edit-distance ratio. Returns 0 for empty names.
 */
function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const j = jaccard(a, b);
  if (j >= 0.75) return j;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return 0.6 + 0.35 * (shorter / longer);
  }
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Compares the product catalogues of two stores. `a` is treated as the
 * reference store; matched pairs are keyed by `productKey` (each product
 * matches at most once, preferring store A's ordering). With `options.fuzzy`
 * the remaining products are additionally matched by normalized-name
 * similarity, so near-identical names (e.g. "USB-C cable" vs "USB C Cable")
 * pair up too — those pairs carry `fuzzy: true`, and the match floor is
 * `options.fuzzyThreshold` (default 0.8).
 */
export function compareStores(
  productsA: SavedCrawlProduct[],
  productsB: SavedCrawlProduct[],
  options: CompareOptions = {},
): StoreComparison {
  const keysB = new Map(productsB.map((p) => [productKey(p), p]));
  const matched: StoreMatch[] = [];
  const onlyA: SavedCrawlProduct[] = [];
  let priceChangedCount = 0;
  const pushMatch = (
    a: SavedCrawlProduct,
    b: SavedCrawlProduct,
    fuzzy: boolean,
    similarity?: number,
  ) => {
    matched.push({
      key: productKey(a),
      a,
      b,
      priceDiff: (b.price ?? 0) - (a.price ?? 0),
      fuzzy,
      similarity,
    });
    if ((b.price ?? 0) !== (a.price ?? 0)) priceChangedCount++;
  };

  // Exact pass — name / slug / URL keys.
  for (const a of productsA) {
    const key = productKey(a);
    const b = keysB.get(key);
    if (b) {
      pushMatch(a, b, false);
      keysB.delete(key);
    } else {
      onlyA.push(a);
    }
  }

  // Fuzzy pass — near-identical names for whatever exact matching left over.
  // Candidates are bucketed by name length so each A only scans B names within
  // the length budget (bounds the worst-case O(n·m) scan on large catalogues).
  if (options.fuzzy && onlyA.length > 0 && keysB.size > 0) {
    // Non-numeric thresholds (e.g. NaN) fall back to the default.
    const t = options.fuzzyThreshold;
    const threshold =
      typeof t === "number" && Number.isFinite(t)
        ? Math.min(1, Math.max(0, t))
        : FUZZY_THRESHOLD;
    const fuzzyMatchedA = new Set<SavedCrawlProduct>();
    const usedB = new Set<SavedCrawlProduct>();
    const bucket = new Map<
      number,
      Array<{ p: SavedCrawlProduct; name: string; used: boolean }>
    >();
    for (const p of keysB.values()) {
      const name = fuzzyName(p.name);
      if (!name) continue;
      const band = Math.round(name.length / 5);
      const list = bucket.get(band) ?? [];
      list.push({ p, name, used: false });
      bucket.set(band, list);
    }
    for (const a of onlyA) {
      const na = fuzzyName(a.name);
      if (!na) continue;
      let bestScore = 0;
      let best: { p: SavedCrawlProduct; name: string; used: boolean } | null =
        null;
      const minBand = Math.max(
        0,
        Math.round((na.length - FUZZY_LEN_BUDGET) / 5),
      );
      const maxBand = Math.round((na.length + FUZZY_LEN_BUDGET) / 5);
      for (let band = minBand; band <= maxBand; band++) {
        for (const cand of bucket.get(band) ?? []) {
          if (cand.used) continue;
          const s = nameSimilarity(na, cand.name);
          if (s > bestScore) {
            bestScore = s;
            best = cand;
          }
        }
      }
      if (best && bestScore >= threshold) {
        best.used = true;
        fuzzyMatchedA.add(a);
        usedB.add(best.p);
        pushMatch(a, best.p, true, bestScore);
      }
    }
    if (fuzzyMatchedA.size > 0) {
      return {
        matched,
        onlyA: onlyA.filter((p) => !fuzzyMatchedA.has(p)),
        onlyB: [...keysB.values()].filter((p) => !usedB.has(p)),
        priceChangedCount,
      };
    }
  }

  return {
    matched,
    onlyA,
    onlyB: [...keysB.values()],
    priceChangedCount,
  };
}
