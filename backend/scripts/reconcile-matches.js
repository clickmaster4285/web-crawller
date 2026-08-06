/**
 * reconcile-matches — one-off backfill for Phase 3 persisted matches.
 *
 * Reconciles ProductMatch rows for the user's store vs EVERY competitor,
 * using the same indexed matching the live pipeline runs per crawl. Safe to
 * re-run anytime (each pair is fully replaced). Use after upgrading existing
 * data (products crawled before Phase 3 have no match rows), or whenever the
 * my-store origin changes.
 *
 * Run: npm run reconcile-matches
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const matchService = require('../services/matchService');

async function main() {
  await connectDatabase();
  const myStore = await matchService.getMyStore();
  if (!myStore?.origin) {
    console.log('ℹ️  No my-store set — nothing to reconcile. Set it on /competitors first.');
    process.exit(0);
  }
  const origins = await matchService.competitorOrigins(myStore.origin);
  console.log(`🔄 Reconcile ${origins.length} competitor(s) against ${myStore.origin}`);
  let total = 0;
  for (const origin of origins) {
    const r = await matchService.reconcilePair(myStore.origin, origin);
    const methods = Object.entries(r.methods)
      .map(([m, n]) => `${m}×${n}`)
      .join(', ');
    console.log(`  ${origin}: ${r.matched} match(es)${methods ? ` [${methods}]` : ''}`);
    total += r.matched;
  }
  console.log(`✅ Done — ${total} match row(s) persisted across ${origins.length} competitor(s).`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error('💥 reconcile failed:', error);
  process.exit(1);
});
