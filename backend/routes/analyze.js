const express = require('express');
const analyzeController = require('../controllers/analyzeController');
const auth = require('../middleware/auth');

const router = express.Router();

// Phase 5 — JWT-protected (the analyzer makes outbound requests on demand).
router.use(auth);

// POST /api/analyze — run the Website Intelligence Analyzer probes against
// an origin (no crawl is enqueued). Body: { origin, proxy? }.
router.post('/', analyzeController.analyzeWebsite);

module.exports = router;
