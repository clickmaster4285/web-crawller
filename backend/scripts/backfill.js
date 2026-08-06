/**
 * Backfill — Phase 1 migration (architecture §9.5 step 2, decision D1).
 *
 * Splits legacy `CrawlResult` docs into the normalized model by REPLAYING
 * each origin's history through the same `syncNewModel` pipeline the live
 * dual-write uses — so backfilled data is consistent with future crawls by
 * construction:
 *
 *   Product      — current state (as of the newest snapshot), one doc per
 *                  identity key; removed products stay soft-deleted.
 *   Snapshot     — one metadata doc per legacy snapshot (capped at 10/origin,
 *                  decision D3).
 *   ProductEvent — the change log derived by diffing consecutive snapshots.
 *
 * Identity details:
 *   - Legacy products store absent gtin/sku as `''` — those are stripped to
 *     `undefined` so the sparse match-tier indexes stay lean (an empty string
 *     would occupy an index entry for every product).
 *   - Identity keys come from `utils/identity.productIdentityKey`, the same
 *     code the matcher and the dual-write use.
 *   - Replays carry the ORIGINAL `createdAt` timestamps, so priceHistory
 *     points, event times and snapshot dates reflect real crawl history.
 *
 * Safety:
 *   - Origins that already have new-model rows are SKIPPED (idempotent).
 *   - `--force` wipes and rebuilds an origin's new-model rows.
 *   - `--dry-run` prints the plan without writing anything.
 *   - Legacy `CrawlResult` docs are never touched (they stay as the read
 *     fallback until Phase 3 flips reads).
 *
 * Usage:
 *   node scripts/backfill.js            # backfill everything not yet done
 *   node scripts/backfill.js --force    # wipe + rebuild all origins
 *   node scripts/backfill.js --dry-run  # show what would happen
 *
 * Memory note: loads one origin's snapshots at a time (not the whole
 * collection); a 10k-product store × 20 snapshots is ~200k product objects
 * per origin — fine for a one-time script.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CrawlResult = require('../models/CrawlResult');
const Product = require('../models/Product');
const Snapshot = require('../models/Snapshot');
const ProductEvent = require('../models/ProductEvent');
const { syncNewModel } = require('../services/crawlSync');
const { productIdentityKey } = require('../utils/identity');
const { connectDatabase } = require('../config/database');

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Legacy products use `gtin: ''` / `sku: ''` for "absent" — strip to
 * undefined so the sparse gtin/sku indexes stay lean (the empty string is a
 * legacy-model artifact the new model deliberately doesn't carry).
 */
function cleanProduct(p) {
  return {
    name: p.name,
    brand: p.brand,
    price: p.price,
    available: p.available,
    url: p.url,
    sku: p.sku || undefined,
    gtin: p.gtin || undefined
  };
}

/** Drop duplicate identity keys within one snapshot (first wins —
 * architecture §10 identity-collision note) so a shared key never yields
 * two `added` events for the same product. */
function dedupeByKey(products) {
  const seen = new Set();
  const out = [];
  for (const p of products) {
    const key = productIdentityKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function main() {
  await connectDatabase();
  const origins = await CrawlResult.distinct('origin');
  console.log(
    `🔍 Found ${origins.length} origin(s) with saved crawls` +
      (DRY_RUN ? ' (dry run — nothing will be written)' : '')
  );

  let totalProducts = 0;
  let totalSnapshots = 0;
  let totalEvents = 0;
  let skipped = 0;
  let failed = 0;

  for (const origin of origins) {
    try {
      const docs = await CrawlResult.find({ origin })
        .sort({ createdAt: 1 }) // oldest first — diffs accumulate correctly
        .select('createdAt stats products failures discovery')
        .lean();

      // Completeness check: a full backfill leaves min(legacy count, cap)
      // snapshots per origin. Fewer than that means a previous run died
      // mid-replay (crash, OOM) — the derived rows are rebuilt rather than
      // trusted as "done". (Dual-write crawls grow legacy docs and snapshots
      // in lockstep, so the counts stay comparable.)
      const expected = Math.min(docs.length, Snapshot.SNAPSHOT_LIMIT);
      const existing = await Snapshot.countDocuments({ origin });
      if (existing >= expected && !FORCE) {
        console.log(
          `⏭️  ${origin} — already backfilled (${existing} snapshot(s)); use --force to rebuild`
        );
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        const newest = docs[docs.length - 1];
        console.log(
          `📋 ${origin} — ${docs.length} snapshot(s), newest has ${newest?.products.length ?? 0} products` +
            (FORCE ? ' (force: would wipe + rebuild)' : '') +
            (existing > 0 && existing < expected
              ? ` (partial: ${existing}/${expected} — would rebuild)`
              : '')
        );
        continue;
      }

      if (existing > 0) {
        const reason =
          existing < expected
            ? `partial new-model data (${existing}/${expected} snapshots) — rebuilding`
            : '--force rebuild';
        console.log(`♻️  ${origin} — ${reason}`);
        // Derived rows are safe to wipe — everything is rebuilt from legacy.
        await Promise.all([
          Product.deleteMany({ origin }),
          Snapshot.deleteMany({ origin }),
          ProductEvent.deleteMany({ origin })
        ]);
      }

      let products = 0;
      let events = 0;
      for (const doc of docs) {
        const result = await syncNewModel({
          origin,
          products: dedupeByKey((doc.products || []).map(cleanProduct)),
          stats: doc.stats || {},
          discovery: doc.discovery || null,
          failures: doc.failures || [],
          fullCrawl: true,
          at: doc.createdAt
        });
        products = result.productCount;
        events +=
          result.addedCount +
          result.removedCount +
          result.priceChangedCount +
          result.stockChangedCount;
      }
      totalProducts += products;
      totalSnapshots += docs.length;
      totalEvents += events;
      console.log(
        `✅ ${origin} — replayed ${docs.length} snapshot(s) → ${products} current products, ${events} events written`
      );
    } catch (err) {
      failed++;
      console.error(`❌ ${origin} — ${err.message}`);
    }
  }

  console.log(
    `\nDone. ${origins.length - skipped - failed} backfilled, ${skipped} skipped, ${failed} failed.` +
      `\n  ${totalProducts} current products · ${totalSnapshots} snapshots replayed · ${totalEvents} events written` +
      (DRY_RUN ? ' (dry run)' : '')
  );
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Backfill crashed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
