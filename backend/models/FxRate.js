/**
 * FxRate — cached daily FX rates (base USD), used by fxService to convert
 * each product's native price into a comparable `Product.priceUsd` at ingest
 * (architecture §4.4 + decision Aug 2026). One doc, upserted on each
 * successful refresh; the ingest pipeline falls back to it when the network
 * refresh fails, so crawling never blocks on a rates outage.
 */
const mongoose = require('mongoose');

const fxRateSchema = new mongoose.Schema(
  {
    base: { type: String, default: 'USD', uppercase: true, unique: true },
    // ISO 4217 code → units of base per 1 unit of code (e.g. AED: 3.6725).
    rates: { type: mongoose.Schema.Types.Mixed, default: {} },
    fetchedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FxRate', fxRateSchema);
