const express = require('express');
const storeController = require('../controllers/storeController');

const router = express.Router();

// Phase 5 read path — the normalized collections replace CrawlResult reads
// (decision D1). `:key` is the normalized host (e.g. store.example.com).
router.get('/', storeController.listStores);
router.get('/:key/products', storeController.listProducts);
router.get('/:key/snapshots', storeController.listSnapshots);
router.get('/:key/events', storeController.listEvents);
router.get('/:key', storeController.getStore);

module.exports = router;
