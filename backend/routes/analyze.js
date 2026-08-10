const express = require('express');
const analyzeController = require('../controllers/analyzeController');

const router = express.Router();

// POST /api/analyze — run the Website Intelligence Analyzer probes against
// an origin (no crawl is enqueued). Body: { origin, proxy? }.
router.post('/', analyzeController.analyzeWebsite);

module.exports = router;
