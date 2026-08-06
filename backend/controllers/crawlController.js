/**
 * CrawlResult controller — persist and read saved crawls.
 *
 * `POST /api/data/crawl-results` stores a finished crawl. With
 * `storeSnapshots: true` (default) each run appends a snapshot and history is
 * capped at `SNAPSHOT_LIMIT` per origin; with `storeSnapshots: false` the
 * latest run replaces the previous one (one doc per origin).
 *
 * `GET /api/data/crawl-results?origin=` lists saved snapshots, newest first,
 * optionally filtered by origin.
 *
 * Since Phase 2 the heavy lifting lives in `services/saveCrawl.js` (shared
 * with the standalone crawl worker); this controller is the HTTP entry point.
 */

const mongoose = require('mongoose');
const CrawlResult = require('../models/CrawlResult');
const Product = require('../models/Product');
const Snapshot = require('../models/Snapshot');
const ProductEvent = require('../models/ProductEvent');
const CrawlJob = require('../models/CrawlJob');
const Store = require('../models/Store');
const { saveFinishedCrawl } = require('../services/saveCrawl');

const saveCrawlResult = async (req, res) => {
  try {
    const {
      origin,
      collections,
      stats,
      products,
      failures,
      discovery,
      storeSnapshots,
      fullCrawl
    } = req.body || {};
    if (!origin) {
      return res.status(400).json({
        success: false,
        message: 'origin is required'
      });
    }
    // Forward the job type (validated) so the back-compat HTTP dual-write
    // records the right legacy-doc type AND the right Store cadence anchor
    // (lastShallowAt vs lastDeepAt) — a shallow post must never look deep.
    const type = req.body?.type === 'shallow' ? 'shallow' : 'deep';
    const { doc, dualWrite } = await saveFinishedCrawl({
      origin,
      collections,
      stats,
      products,
      failures,
      discovery,
      storeSnapshots,
      fullCrawl,
      type
    });
    console.log(
      `💾 Saved crawl result for ${origin}: ${doc.products.length} products` +
        (storeSnapshots === false ? ' (replace mode)' : ' (snapshot mode)')
    );
    res.json({
      success: true,
      data: doc,
      dualWrite
    });
  } catch (error) {
    console.error('Save crawl result error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

const getCrawlResults = async (req, res) => {
  try {
    const { origin, meta } = req.query;
    const isMeta = meta === '1' || meta === 'true';
    let docs;
    if (isMeta) {
      // Summary mode — used by store pickers/lists that only need origin,
      // platform, product count and timestamps. Product catalogues are NOT
      // loaded, so this stays tiny even with tens of thousands of products
      // (10.8 MB of products -> ~10 KB of summaries).
      const pipeline = [
        ...(origin ? [{ $match: { origin } }] : []),
        { $sort: { createdAt: -1 } },
        { $limit: 500 },
        {
          $project: {
            _id: 1,
            origin: 1,
            type: { $ifNull: ['$type', 'deep'] },
            createdAt: 1,
            updatedAt: 1,
            stats: 1,
            productCount: { $size: { $ifNull: ['$products', []] } },
            platform: { $ifNull: ['$discovery.platform.platform', null] }
          }
        }
      ];
      docs = await CrawlResult.aggregate(pipeline);
    } else {
      const filter = origin ? { origin } : {};
      docs = await CrawlResult.find(filter).sort({ createdAt: -1 }).limit(50);
    }
    res.json({
      success: true,
      count: docs.length,
      data: docs
    });
  } catch (error) {
    console.error('Get crawl results error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

/** Deletes a single saved crawl snapshot by id. */
const deleteCrawlResult = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid crawl result id'
      });
    }
    const doc = await CrawlResult.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Crawl result not found'
      });
    }
    console.log(`🗑️ Deleted crawl result ${id} for ${doc.origin}`);
    res.json({
      success: true,
      data: { deleted: true, id, origin: doc.origin }
    });
  } catch (error) {
    console.error('Delete crawl result error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

/** Deletes every saved snapshot for an origin (`DELETE /crawl-results?origin=`). */
const deleteCrawlResultsByOrigin = async (req, res) => {
  try {
    const origin = req.query.origin;
    if (typeof origin !== 'string' || !origin.trim()) {
      return res.status(400).json({
        success: false,
        message: 'origin query param is required'
      });
    }
    const result = await CrawlResult.deleteMany({ origin });
    // Phase 1 dual-write mirror: clearing a store's history also clears the
    // normalized model for that origin, so no orphaned Product/Snapshot/Event
    // rows survive the UI's "clear history" and resurface after Phase 3.
    await Promise.all([
      Product.deleteMany({ origin }),
      Snapshot.deleteMany({ origin }),
      ProductEvent.deleteMany({ origin }),
      // Phase 2: drop pending/claimed jobs so a deleted store stops being
      // crawled, and disable its schedule (the Store doc stays — the worker
      // may still update it after a manual run, and re-scheduling re-enables).
      CrawlJob.deleteMany({
        origin,
        status: { $in: ['queued', 'claimed', 'retrying'] }
      }),
      Store.updateMany({ origin }, { $set: { 'cadence.enabled': false } })
    ]);
    console.log(
      `🗑️ Cleared ${result.deletedCount} crawl result(s) for ${origin}` +
        ' (dual-write mirror cleared)'
    );
    res.json({
      success: true,
      data: { deleted: true, origin, deletedCount: result.deletedCount }
    });
  } catch (error) {
    console.error('Delete crawl results by origin error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

module.exports = {
  saveCrawlResult,
  getCrawlResults,
  deleteCrawlResult,
  deleteCrawlResultsByOrigin
};
