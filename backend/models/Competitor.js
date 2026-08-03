/**
 * Competitor — a store the user added manually to monitor. Crawled origins
 * are derived automatically from the CrawlResult collection; this model holds
 * the user-curated list (with an optional friendly name) so competitors can
 * exist before their first crawl.
 */
const mongoose = require('mongoose');

const competitorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true
    },
    origin: {
      type: String,
      required: [true, 'Origin URL is required'],
      trim: true,
      lowercase: true,
      unique: true
    },
    notes: {
      type: String,
      default: ''
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Competitor', competitorSchema);
