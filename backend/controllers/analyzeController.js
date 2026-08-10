/**
 * analyzeController — P2 Website Intelligence Analyzer endpoint (Phase 2 UI).
 *
 *   POST /api/analyze  { origin, proxy? } → WebsiteProfile
 *
 * Runs the SAME analyzer the CLI runs (`node tools/analyze.mjs`) — the five
 * probes (platform, Shopify/Woo/BigCommerce APIs, JSON-LD, bot protection,
 * render mode) answer "how is this site built and what's the optimal way to
 * crawl it?" in ~5–20 polite requests WITHOUT enqueuing a crawl. The Sources
 * page's "Run analysis" button calls this, renders the profile, and offers
 * to pre-fill the crawl config from the recommendation.
 *
 * The analyzer lives in the frontend package and is loaded here the same way
 * worker.mjs loads the crawler engine: Node 24 strips TS types on import, so
 * the `.ts` source runs directly. No build step.
 */
const { pathToFileURL } = require('url');
const path = require('path');

// The analyzer module path — resolves relative to this file (backend/
// controllers/), so the sibling frontend package is TWO levels up.
const ANALYZE_MODULE = path.join(
  __dirname,
  '../../frontend/src/lib/crawler/analyze.ts'
);

let analyzeModulePromise = null;
/** Loads the type-stripped analyzer once per process (cached like the
 *  backend's other frontend-module imports). */
function getAnalyzeModule() {
  analyzeModulePromise ??= import(pathToFileURL(ANALYZE_MODULE).href);
  return analyzeModulePromise;
}

/**
 * Runs the analyzer probes against `origin` (optionally through `proxy`).
 * Polite by construction: the analyzer throttles every request, respects
 * robots.txt, and holds a hard request budget (default 20).
 *
 * Shared by two callers:
 *   - the POST /api/analyze handler (standalone "Run analysis" button)
 *   - jobController's analyze-first crawls (the pre-crawl probes that pick
 *     the crawl strategy before a manual deep crawl is enqueued)
 */
async function runAnalyzer(origin, proxy) {
  const { analyzeWebsite: run } = await getAnalyzeModule();
  return run(origin, proxy ? { proxy } : {});
}

/**
 * POST /api/analyze — runs the analyzer probes against `origin` and returns
 * the WebsiteProfile. `proxy` (optional Tier-2 residential gateway) routes
 * every probe request through the proxy, exactly like a crawl would — so a
 * store that 429s this machine can be analyzed through the same proxy the
 * crawl will use. The proxy URL is never persisted or logged.
 */
const analyzeWebsite = async (req, res) => {
  try {
    const origin = String(req.body?.origin ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(origin)) {
      return res
        .status(400)
        .json({ success: false, message: 'Origin must be a valid http(s) URL' });
    }
    const proxy = req.body?.proxy != null ? String(req.body.proxy).trim() : '';
    if (proxy && !/^https?:\/\/\S+/i.test(proxy)) {
      return res
        .status(400)
        .json({ success: false, message: 'Proxy must be a valid http(s) URL' });
    }
    const profile = await runAnalyzer(origin, proxy || undefined);
    res.json({ success: true, data: profile });
  } catch (error) {
    console.error('Analyze error:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};

module.exports = { analyzeWebsite, runAnalyzer, getAnalyzeModule };
