const express = require("express");
const dataController = require("../controllers/dataController");
const competitorController = require("../controllers/competitorController");
const myStoreController = require("../controllers/myStoreController");
const alertsController = require("../controllers/alertsController");
const metricsController = require("../controllers/metricsController");
const auth = require("../middleware/auth");

const router = express.Router();

// Phase 5 — the whole data API is auth-protected. The frontend attaches the
// JWT on every request (`lib/http.ts`) and redirects to login on 401; only
// /api/auth/* stays open (login/register).
router.use(auth);

router.get("/workspace", dataController.workspace);
router.get("/my-store", myStoreController.getMyStore);
router.put("/my-store", myStoreController.setMyStore);
router.get("/analytics", dataController.analytics);
router.get("/competitors", dataController.competitors);
router.post("/competitors", competitorController.createCompetitor);
router.delete("/competitors/:id", competitorController.deleteCompetitor);
router.get("/matched-products", dataController.matchedProducts);
router.get("/pricing", dataController.pricing);
router.get("/catalogue", dataController.catalogue);
router.get("/insights", dataController.insights);
router.get("/reports", dataController.reports);

// Phase 5 — observability: crawl-job health snapshot (queue, workers,
// throughput, durations — all derived live from CrawlJob).
router.get("/metrics", metricsController.getMetrics);

// Phase 4 — alerts feed + per-user read/dismiss state (auth via router.use).
router.get("/alerts", alertsController.list);
router.post("/alerts/read", alertsController.markRead);
router.post("/alerts/read-all", alertsController.markAllRead);
router.post("/alerts/dismiss", alertsController.dismiss);

module.exports = router;
