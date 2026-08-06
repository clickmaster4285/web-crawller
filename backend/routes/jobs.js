const express = require('express');
const jobController = require('../controllers/jobController');

const router = express.Router();

// Order matters: literal /schedules routes must precede the /:id param route.
router.post('/', jobController.enqueueCrawlJob);
router.get('/schedules', jobController.listSchedules);
router.post('/schedules', jobController.upsertSchedule);
router.delete('/schedules/:origin', jobController.cancelSchedule);
router.get('/:id', jobController.getCrawlJob);

module.exports = router;
