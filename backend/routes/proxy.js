const express = require('express');
const proxyController = require('../controllers/proxyController');
const auth = require('../middleware/auth');

const router = express.Router();

// Phase 5 — JWT-protected (the proxy gateway URL is submitted here).
router.use(auth);

// POST /api/proxy/test — verify a Tier-2 residential proxy gateway and report
// the exit IP it would use. Body: { proxy, url? }.
router.post('/test', proxyController.testProxy);

module.exports = router;
