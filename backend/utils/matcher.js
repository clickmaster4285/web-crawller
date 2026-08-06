/**
 * Server-side product matcher (GTIN > SKU > URL slug > fuzzy name).
 *
 * Compares the user's own catalogue against one competitor's catalogue and
 * returns matched pairs plus the unmatched tails. Identity tiers are tried in
 * priority order per product, exactly as planned for the matching layer:
 *
 *   1. **GTIN**  — normalized (digits-only) barcode/UPC/EAN equality.
 *   2. **SKU**   — normalized (alphanumeric, lowercase) manufacturer SKU.
 *   3. **URL slug** — the URL's last path segment (lowercase).
 *   4. **Fuzzy** — normalized-name similarity (token overlap, containment,
 *      edit distance) above a threshold, reusing the same machinery the
 *      client-side `compareStores` uses.
 *
 * Each product matches at most once; competitors' products are consumed as
 * they match, so a row never pairs twice. `confidence` is 100 for exact
 * tiers and the rounded similarity percentage for fuzzy matches.
 */

/** Minimum GTIN length (GTIN-8 is the shortest standard) before we trust it. */
const GTIN_MIN_LENGTH = 8;
/** Minimum slug length — generic one-char segments (`/p`, `/dp`) never match. */
const SLUG_MIN_LENGTH = 3;
/** Minimum similarity (0..1) for two names to count as the same product. */
const FUZZY_THRESHOLD = 0.8;
/** Rough length budget for edit-distance candidates (bounds the scan). */
const FUZZY_LEN_BUDGET = 15;

/**
 * Worst-case pair count for the fuzzy pass (onlyMine × unmatched theirs).
 * Above it the pass is skipped: with large catalogues the scan would take
 * minutes of synchronous CPU and block the whole Express event loop (every
 * route, including /health, freezes). Exact tiers (GTIN/SKU/slug) still
 * match, so a bounded fuzzy tier is a fair trade-off for staying responsive.
 */
const FUZZY_PAIR_LIMIT = 50_000;

/** Digits-only GTIN/EAN/UPC normalization. */
function normalizeGtin(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.length >= GTIN_MIN_LENGTH ? digits : '';
}

/** Lowercase alphanumeric SKU normalization. */
function normalizeSku(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Lowercased last path segment of a product URL. */
function slugFromUrl(url) {
  try {
    const parts = new URL(url).pathname
      .replace(/\/$/, '')
      .split('/')
      .filter(Boolean);
    const slug = (parts[parts.length - 1] || '').toLowerCase();
    return slug.length >= SLUG_MIN_LENGTH ? slug : '';
  } catch {
    return '';
  }
}

/** Normalizes a product name for fuzzy comparison (punctuation → space). */
function fuzzyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalized name tokens (the inverted-index vocabulary, architecture §4.2).
 * Stored per Product at ingest so fuzzy candidates can be fetched with a
 * `tokens: { $in: […] }` multikey-index lookup instead of a full scan.
 */
function nameTokens(name) {
  return fuzzyName(name).split(' ').filter(Boolean);
}

/** Token overlap (Jaccard index) of two normalized names. */
function jaccard(a, b) {
  const tokensA = new Set(a.split(' '));
  const tokensB = new Set(b.split(' '));
  let inter = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) inter++;
  }
  const union = tokensA.size + tokensB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Classic Levenshtein edit distance. */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * 0..1 similarity between two normalized names: equality, token overlap,
 * substring containment (one store appends a colour/size), edit distance.
 */
function nameSimilarity(a, b) {
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

/** Identity keys of a product, in match priority order (empty = skipped). */
function identityKeys(product) {
  return {
    gtin: normalizeGtin(product.gtin || product.barcode),
    sku: normalizeSku(product.sku),
    slug: slugFromUrl(product.url),
  };
}

/**
 * Matches the user's catalogue (`mine`) against one competitor's (`theirs`).
 * Returns matched pairs (with `method` and `confidence`), plus the
 * unmatched tails of both sides. `method` ∈ GTIN | SKU | URL slug | fuzzy
 * (aligned with the ProductMatch model enum — Phase 3).
 */
function matchCatalogues(mine, theirs, options = {}) {
  const threshold =
    typeof options.fuzzyThreshold === 'number' &&
    Number.isFinite(options.fuzzyThreshold)
      ? Math.min(1, Math.max(0, options.fuzzyThreshold))
      : FUZZY_THRESHOLD;

  // Competitor indexes per identity tier (first product wins a shared key).
  const byGtin = new Map();
  const bySku = new Map();
  const bySlug = new Map();
  const used = new Set();
  const indexTier = (map, p, key) => {
    if (key && !map.has(key)) map.set(key, p);
  };
  for (const p of theirs) {
    const keys = identityKeys(p);
    indexTier(byGtin, p, keys.gtin);
    indexTier(bySku, p, keys.sku);
    indexTier(bySlug, p, keys.slug);
  }

  const matched = [];
  const onlyMine = [];
  const take = (mine, theirs, method, confidence) => {
    used.add(theirs);
    matched.push({ mine, theirs, method, confidence });
  };

  // Passes 1-3: exact identity tiers in priority order. Each tier is checked
  // independently so a taken competitor (matched earlier by another of our
  // products) falls through to the next tier instead of being lost.
  for (const m of mine) {
    const keys = identityKeys(m);
    let candidate = null;
    let method = null;
    if (keys.gtin) {
      const c = byGtin.get(keys.gtin);
      if (c && !used.has(c)) {
        candidate = c;
        method = 'GTIN';
      }
    }
    if (!candidate && keys.sku) {
      const c = bySku.get(keys.sku);
      if (c && !used.has(c)) {
        candidate = c;
        method = 'SKU';
      }
    }
    if (!candidate && keys.slug) {
      const c = bySlug.get(keys.slug);
      if (c && !used.has(c)) {
        candidate = c;
        method = 'URL slug';
      }
    }
    if (candidate) take(m, candidate, method, 100);
    else onlyMine.push(m);
  }

  // Pass 4: fuzzy name similarity for whatever exact matching left over.
  // Candidates are bucketed by name length so each A only scans B names
  // within the length budget. Worst case is still O(onlyMine × in-band
  // candidates) × Levenshtein, so when catalogues are huge the pass is
  // skipped entirely (FUZZY_PAIR_LIMIT) — exact tiers still match and the
  // server can never be wedged by a multi-minute synchronous scan.
  const freeTheirs = theirs.filter((p) => !used.has(p));
  if (
    onlyMine.length > 0 &&
    onlyMine.length * freeTheirs.length <= FUZZY_PAIR_LIMIT
  ) {
    const bucket = new Map();
    for (const p of freeTheirs) {
      const name = fuzzyName(p.name);
      if (!name) continue;
      const band = Math.round(name.length / 5);
      const list = bucket.get(band) ?? [];
      list.push({ p, name, used: false });
      bucket.set(band, list);
    }
    for (const mine of onlyMine) {
      const na = fuzzyName(mine.name);
      if (!na) continue;
      let bestScore = 0;
      let best = null;
      const minBand = Math.max(0, Math.round((na.length - FUZZY_LEN_BUDGET) / 5));
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
        used.add(best.p);
        matched.push({
          mine,
          theirs: best.p,
          method: 'fuzzy',
          confidence: Math.round(bestScore * 100),
        });
      }
    }
  }

  return {
    matched,
    onlyMine: onlyMine.filter(
      (m) => !matched.some((pair) => pair.mine === m)
    ),
    onlyTheirs: theirs.filter((p) => !used.has(p)),
  };
}

module.exports = {
  matchCatalogues,
  normalizeGtin,
  normalizeSku,
  slugFromUrl,
  nameSimilarity,
  nameTokens,
  FUZZY_THRESHOLD,
};
