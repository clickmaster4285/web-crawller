/**
 * fxService — daily FX rates → priceUsd (architecture §4.4, decision Aug 2026).
 *
 * Cross-store price comparison is meaningless when stores price in different
 * currencies (AED/PKR/OMR/USD… — already true across this app's stores). The
 * ingest pipeline converts each product's native price to USD at write time
 * (`Product.priceUsd`) using the latest rates, so the matcher, price gaps and
 * market aggregates can compare in ONE currency while native prices stay for
 * display.
 *
 * Source: open.er-api.com/v6/latest/USD — free, no key, updated daily, fetched
 * from the backend at ingest via Node's global fetch. Results are cached
 * in-process (24h) and persisted in the `fxrates` collection, so a network
 * outage never bricks crawling: a refresh failure falls back to the last good
 * cached table (stale-but-better-than-nothing), and a fresh install degrades
 * to `{}` (cross-currency comparison simply stays disabled until a refresh
 * succeeds). Unknown currencies produce `null` priceUsd — the product still
 * stores its native price.
 */
const FxRate = require('../models/FxRate');

const API_URL =
  process.env.PARITY_FX_API_URL ?? 'https://open.er-api.com/v6/latest/USD';
/** How long a fetched rate table is trusted before a refresh is attempted. */
const REFRESH_MS = 24 * 60 * 60 * 1000;

/** In-process cache between Mongo reads (rates are tiny and slow-changing). */
let memoryCache = null; // { fetchedAt: Date, rates: Object }

/** Fetches a fresh USD-base rate table from the API. Throws on failure. */
async function fetchRates() {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FX API responded ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.rates !== 'object') {
    throw new Error('FX API returned no rates');
  }
  return { fetchedAt: new Date(), rates: body.rates };
}

/**
 * Latest USD-base rates. Refreshes once/day (in-process), persists the table
 * on success, and falls back to the persisted copy when the refresh fails.
 * Never throws — returns `{}` only when nothing has ever been fetched.
 */
async function getRates() {
  const fresh =
    memoryCache && Date.now() - memoryCache.fetchedAt.getTime() < REFRESH_MS;
  if (fresh) return memoryCache.rates;
  try {
    const table = await fetchRates();
    memoryCache = table;
    await FxRate.updateOne(
      { base: 'USD' },
      { $set: { rates: table.rates, fetchedAt: table.fetchedAt } },
      { upsert: true }
    ).catch(() => {});
    return table.rates;
  } catch (error) {
    const doc = await FxRate.findOne({ base: 'USD' }).lean().catch(() => null);
    if (doc) {
      memoryCache = { fetchedAt: doc.fetchedAt, rates: doc.rates };
    } else {
      // Nothing cached yet — degrade to an empty table (comparison disabled).
      memoryCache = memoryCache ?? { fetchedAt: new Date(0), rates: {} };
    }
    console.warn(
      `fxService: rates refresh failed (${error.message}) — using cached rates`
    );
    return memoryCache.rates;
  }
}

/**
 * Converts a native price to USD via a rate table. Returns `null` when there's
 * no usable price, the currency is unknown, or the rate is missing — a
 * product that can't be normalized simply isn't cross-currency comparable yet.
 * USD prices pass through unchanged (no rate lookup).
 */
function toUsd(price, currency, rates) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  const c = String(currency || '').toUpperCase().trim();
  if (!c || c === 'USD') return price;
  const rate = rates?.[c];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  return Math.round((price / rate) * 100) / 100;
}

module.exports = { fetchRates, getRates, toUsd, REFRESH_MS };
