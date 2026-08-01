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
 */

const CrawlResult = require('../models/CrawlResult');

/** Max snapshots kept per origin in history mode. */
const SNAPSHOT_LIMIT = 20;

const saveCrawlResult = async (req, res) => {
  try {
    const {
      origin,
      collections,
      stats,
      products,
      failures,
      discovery,
      storeSnapshots
    } = req.body || {};
    if (!origin) {
      return res.status(400).json({
        success: false,
        message: 'origin is required'
      });
    }
    const payload = {
      origin,
      collections: Array.isArray(collections) ? collections : [],
      stats: stats || {},
      products: Array.isArray(products) ? products : [],
      failures: Array.isArray(failures) ? failures : [],
      discovery: discovery || null
    };

    let doc;
    if (storeSnapshots === false) {
      // Replace mode — keep only the latest snapshot per origin (removes any
      // earlier snapshots left by history mode). The metadata check guards a
      // rare race: without a unique index, two concurrent replace-upserts for
      // the same origin can both *insert*; running deleteMany unconditionally
      // would then let each delete the other's doc (leaving zero). Only clean
      // up when this call actually updated an existing doc.
      const result = await CrawlResult.findOneAndUpdate(
        { origin },
        payload,
        {
          upsert: true,
          new: true,
          runValidators: true,
          includeResultMetadata: true
        }
      );
      doc = result.value;
      if (result.lastErrorObject?.updatedExisting) {
        await CrawlResult.deleteMany({ origin, _id: { $ne: doc._id } });
      }
    } else {
      // History mode — append a snapshot, then cap history per origin.
      doc = await CrawlResult.create(payload);
      const keep = await CrawlResult.find({ origin })
        .sort({ createdAt: -1 })
        .limit(SNAPSHOT_LIMIT)
        .select('_id');
      await CrawlResult.deleteMany({
        origin,
        _id: { $nin: keep.map((d) => d._id) }
      });
    }
    console.log(
      `💾 Saved crawl result for ${origin}: ${doc.products.length} products` +
        (storeSnapshots === false ? ' (replace mode)' : ' (snapshot mode)')
    );
    res.json({
      success: true,
      data: doc
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
    const filter = req.query.origin ? { origin: req.query.origin } : {};
    const docs = await CrawlResult.find(filter).sort({ createdAt: -1 }).limit(50);
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

module.exports = { saveCrawlResult, getCrawlResults };
