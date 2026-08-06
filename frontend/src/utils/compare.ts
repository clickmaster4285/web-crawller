import type { SavedCrawlProduct } from "@/api";

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
  /**
   * True when the fuzzy pass was skipped because the candidate workload
   * exceeded the in-browser budget (exact matches still ran). Set on very
   * large catalogues so the page never freezes.
   */
  fuzzySkipped?: boolean;
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
/**
 * Tokens whose catalogue bucket exceeds this are treated as too generic to
 * index (e.g. "with", "2024", "black") — indexing them would pull in
 * thousands of candidates per product name.
 */
const MAX_TOKEN_BUCKET = 250;
/** Per-product cap on fuzzy candidate evaluations. */
const FUZZY_PER_NAME_CAP = 500;
/**
 * Hard cap on fuzzy similarity evaluations across the whole comparison.
 * Beyond this the fuzzy pass is skipped (exact GTIN/SKU/URL/name matches
 * still run) so tens of thousands of products can never wedge the browser.
 */
const FUZZY_PAIR_BUDGET = 2_500_000;
/** How many fuzzy products are processed between event-loop yields. */
const FUZZY_YIELD_EVERY = 100;

/** Normalizes a product name for fuzzy comparison (lowercase, punctuation → space). */
function fuzzyName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The normalized-name tokens of a product (empty for blank names). */
function nameTokens(name: string): string[] {
  return fuzzyName(name).split(" ").filter(Boolean);
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

function thresholdOf(t: unknown): number {
  return typeof t === "number" && Number.isFinite(t)
    ? Math.min(1, Math.max(0, t))
    : FUZZY_THRESHOLD;
}

/** Pushes a matched pair onto the exact-pass state (updating price deltas). */
function pushMatch(
  state: ExactState,
  a: SavedCrawlProduct,
  b: SavedCrawlProduct,
  fuzzy: boolean,
  similarity?: number,
) {
  state.matched.push({
    key: productKey(a),
    a,
    b,
    priceDiff: (b.price ?? 0) - (a.price ?? 0),
    fuzzy,
    similarity,
  });
  if ((b.price ?? 0) !== (a.price ?? 0)) state.priceChangedCount++;
}

interface ExactState {
  matched: StoreMatch[];
  onlyA: SavedCrawlProduct[];
  /** Store B products left after exact matching — the fuzzy pool. */
  remainingB: SavedCrawlProduct[];
  priceChangedCount: number;
}

/**
 * Exact pass — name / slug / URL keys. Each product matches at most once,
 * preferring store A's ordering. O(n + m), always fast.
 */
function exactPass(
  productsA: SavedCrawlProduct[],
  productsB: SavedCrawlProduct[],
): ExactState {
  const keysB = new Map(productsB.map((p) => [productKey(p), p]));
  const state: ExactState = {
    matched: [],
    onlyA: [],
    remainingB: [],
    priceChangedCount: 0,
  };
  for (const a of productsA) {
    const key = productKey(a);
    const b = keysB.get(key);
    if (b) {
      pushMatch(state, a, b, false);
      keysB.delete(key);
    } else {
      state.onlyA.push(a);
    }
  }
  state.remainingB = [...keysB.values()];
  return state;
}

/** One candidate product in store B, with its precomputed fuzzy metadata. */
interface FuzzyEntry {
  p: SavedCrawlProduct;
  /** Fuzzy-normalized name. */
  name: string;
  /** Length band (bucketed like the exact pass bounds fuzzy work). */
  band: number;
  used: boolean;
}

interface FuzzyContext {
  tokenIndex: Map<string, FuzzyEntry[]>;
  bandIndex: Map<number, FuzzyEntry[]>;
}

/** Indexes store B's leftover products by name token + length band. */
function buildFuzzyContext(products: SavedCrawlProduct[]): FuzzyContext {
  const tokenIndex = new Map<string, FuzzyEntry[]>();
  const bandIndex = new Map<number, FuzzyEntry[]>();
  for (const p of products) {
    const name = fuzzyName(p.name);
    if (!name) continue;
    const entry: FuzzyEntry = {
      p,
      name,
      band: Math.round(name.length / 5),
      used: false,
    };
    const bandList = bandIndex.get(entry.band);
    if (bandList) bandList.push(entry);
    else bandIndex.set(entry.band, [entry]);
    for (const token of nameTokens(name)) {
      const list = tokenIndex.get(token);
      if (list) list.push(entry);
      else tokenIndex.set(token, [entry]);
    }
  }
  return { tokenIndex, bandIndex };
}

/**
 * Candidate store-B entries for one normalized store-A name.
 *
 * Products are pulled from the *rarest* matching tokens first (the most
 * specific words are the best discriminators) until the per-name cap is hit;
 * tokens whose bucket is huge (generic words) are skipped entirely. This
 * turns the naive O(n·m) scan into a few hundred similarity checks per
 * product, even across tens of thousands of items. Single-token names fall
 * back to a bounded length-band scan.
 */
function fuzzyCandidates(na: string, ctx: FuzzyContext): FuzzyEntry[] {
  const tokens = na.split(" ");
  const candidates = new Set<FuzzyEntry>();
  const minBand = Math.max(0, Math.round((na.length - FUZZY_LEN_BUDGET) / 5));
  const maxBand = Math.round((na.length + FUZZY_LEN_BUDGET) / 5);
  const inBand = (e: FuzzyEntry) => e.band >= minBand && e.band <= maxBand;

  if (tokens.length >= 2) {
    const ranked = tokens
      .map((t) => ({ t, bucket: ctx.tokenIndex.get(t)?.length ?? 0 }))
      .filter(({ bucket }) => bucket > 0 && bucket <= MAX_TOKEN_BUCKET)
      .sort((a, b) => a.bucket - b.bucket);
    for (const { t } of ranked) {
      for (const e of ctx.tokenIndex.get(t) ?? []) {
        if (!inBand(e)) continue;
        candidates.add(e);
        if (candidates.size >= FUZZY_PER_NAME_CAP) return [...candidates];
      }
    }
  }

  // Fallback for single-token names (or names whose tokens are all generic):
  // a bounded scan of the length band keeps a chance to match without blowup.
  if (candidates.size === 0) {
    for (let band = minBand; band <= maxBand; band++) {
      for (const e of ctx.bandIndex.get(band) ?? []) {
        candidates.add(e);
        if (candidates.size >= FUZZY_PER_NAME_CAP) break;
      }
      if (candidates.size >= FUZZY_PER_NAME_CAP) break;
    }
  }
  return [...candidates];
}

/** Finds the best fuzzy match for one store-A product against the context. */
function matchOne(
  a: SavedCrawlProduct,
  ctx: FuzzyContext,
  threshold: number,
): { best: FuzzyEntry | null; bestScore: number; evaluated: number } {
  const na = fuzzyName(a.name);
  if (!na) return { best: null, bestScore: 0, evaluated: 0 };
  let bestScore = 0;
  let best: FuzzyEntry | null = null;
  let evaluated = 0;
  for (const cand of fuzzyCandidates(na, ctx)) {
    if (cand.used) continue;
    evaluated++;
    const s = nameSimilarity(na, cand.name);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return {
    best: best && bestScore >= threshold ? best : null,
    bestScore,
    evaluated,
  };
}

function finalize(
  state: ExactState,
  fuzzyMatchedA: Set<SavedCrawlProduct>,
  usedB: Set<SavedCrawlProduct>,
  fuzzySkipped: boolean,
): StoreComparison {
  const result: StoreComparison = {
    matched: state.matched,
    onlyA: state.onlyA.filter((p) => !fuzzyMatchedA.has(p)),
    onlyB: state.remainingB.filter((p) => !usedB.has(p)),
    priceChangedCount: state.priceChangedCount,
  };
  if (fuzzySkipped) result.fuzzySkipped = true;
  return result;
}

/** Hands control back to the browser's event loop. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Compares the product catalogues of two stores. `a` is treated as the
 * reference store; matched pairs are keyed by `productKey` (each product
 * matches at most once, preferring store A's ordering). With `options.fuzzy`
 * the remaining products are additionally matched by normalized-name
 * similarity, so near-identical names (e.g. "USB-C cable" vs "USB C Cable")
 * pair up too — those pairs carry `fuzzy: true`, and the match floor is
 * `options.fuzzyThreshold` (default 0.8).
 *
 * Candidate selection is token-indexed and budget-capped, so this stays fast
 * even on very large catalogues; when the workload would be too big the fuzzy
 * pass is skipped and `fuzzySkipped` is set (exact matches still run).
 *
 * The fuzzy pass is processed in chunks that yield to the event loop between
 * slices, so a comparison of tens of thousands of products never blocks the
 * main thread (no "Page Unresponsive" while it runs).
 *
 * `onProgress(done, total)` reports fuzzy-pass progress over the number of
 * store-A products processed.
 */
export async function compareStoresAsync(
  productsA: SavedCrawlProduct[],
  productsB: SavedCrawlProduct[],
  options: CompareOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<StoreComparison> {
  const state = exactPass(productsA, productsB);
  if (
    !options.fuzzy ||
    state.onlyA.length === 0 ||
    state.remainingB.length === 0
  ) {
    return finalize(state, new Set(), new Set(), false);
  }
  const threshold = thresholdOf(options.fuzzyThreshold);
  const ctx = buildFuzzyContext(state.remainingB);
  const fuzzyMatchedA = new Set<SavedCrawlProduct>();
  const usedB = new Set<SavedCrawlProduct>();
  let evaluated = 0;
  let skipped = false;
  const total = state.onlyA.length;
  let processed = 0;
  for (let i = 0; i < total; i++) {
    const a = state.onlyA[i];
    const r = matchOne(a, ctx, threshold);
    evaluated += r.evaluated;
    processed = i + 1;
    if (evaluated > FUZZY_PAIR_BUDGET) {
      skipped = true;
      break;
    }
    if (r.best) {
      r.best.used = true;
      fuzzyMatchedA.add(a);
      usedB.add(r.best.p);
      pushMatch(state, a, r.best.p, true, r.bestScore);
    }
    if (processed % FUZZY_YIELD_EVERY === 0) {
      onProgress?.(processed, total);
      await yieldToMain();
    }
  }
  onProgress?.(processed, total);
  return finalize(state, fuzzyMatchedA, usedB, skipped);
}
