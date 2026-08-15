const express = require('express');
const storeController = require('../controllers/storeController');
const auth = require('../middleware/auth');

const router = express.Router();

// Phase 5 — JWT-protected like /api/data. The frontend attaches the token on
// every request (browser http client + server-fn cookie forwarding); only
// /api/auth/* stays open.
router.use(auth);

// Phase 5 read path — the normalized collections replace CrawlResult reads
// (decision D1). `:key` is the normalized host (e.g. store.example.com).
router.get('/', storeController.listStores);
router.get('/:key/products', storeController.listProducts);
router.get('/:key/snapshots', storeController.listSnapshots);
// Snapshot history deletes (D1) — clear a store's history, or one snapshot.
router.delete('/:key/snapshots', storeController.clearStoreSnapshots);
router.delete('/:key/snapshots/:id', storeController.deleteStoreSnapshot);
router.get('/:key/events', storeController.listEvents);
router.get('/:key', storeController.getStore);
// Cascade delete — normalized collections only (the legacy crawlresults
// collection is intentionally left untouched — teardown code, keep data).
router.delete('/:key', storeController.deleteStore);

module.exports = router;
