const express = require('express');
const jobController = require('../controllers/jobController');
const auth = require('../middleware/auth');

const router = express.Router();

// Phase 5 — JWT-protected (crawl enqueue/controls/schedules are user actions).
router.use(auth);

// Order matters: literal routes (/schedules, /active) must precede the
// /:id param routes, and /:id/action routes must precede /:id.
router.post('/', jobController.enqueueCrawlJob);
router.get('/schedules', jobController.listSchedules);
router.post('/schedules', jobController.upsertSchedule);
router.delete('/schedules/:origin', jobController.cancelSchedule);
router.get('/active', jobController.listActive);
router.post('/:id/pause', jobController.pauseJob);
router.post('/:id/resume', jobController.resumeJob);
router.post('/:id/cancel', jobController.cancelJob);
router.get('/:id', jobController.getCrawlJob);

module.exports = router;
