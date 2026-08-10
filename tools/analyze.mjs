// P2 — Website Intelligence Analyzer CLI (Phase 1).
//
// Answers "how is this site built, and what's the optimal way to crawl it?"
// in a handful of polite requests, BEFORE a crawl starts — the pre-flight
// tool that prevents the "10k fetched / 0 priced" class of failure.
//
// Runs the 5 probes from frontend/src/lib/crawler/analyze.ts via Node 24's
// native type-stripping (`import()` of a .ts module — the same mechanism the
// worker uses for the crawler engine). No build step, no bundler, no Chrome.
//
// Usage:
//   node tools/analyze.mjs activefitnessstore.com          # readable report
//   node tools/analyze.mjs activefitnessstore.com --json   # WebsiteProfile JSON
//   node tools/analyze.mjs https://store.com/ --budget 15  # tighter request cap

const args = process.argv.slice(2);
const urlArg = args.find((a) => !a.startsWith("--"));
const asJson = args.includes("--json");
// Accept both `--budget=15` and `--budget 15`; an unparseable value falls
// back to the default instead of silently disabling the cap (NaN would make
// `requests >= NaN` always false).
const budgetIndex = args.indexOf("--budget");
const budgetRaw =
  budgetIndex >= 0 ? args[budgetIndex + 1] ?? args[budgetIndex].split("=")[1] : undefined;
const parsedBudget = Number(budgetRaw);
const budget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 20;

if (!urlArg) {
  console.error("Usage: node tools/analyze.mjs <url> [--json] [--budget=N]");
  process.exit(1);
}

let origin = urlArg.trim();
if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;

const { analyzeWebsite } = await import(
  new URL("../frontend/src/lib/crawler/analyze.ts", import.meta.url).href
);

const started = Date.now();
const profile = await analyzeWebsite(origin, {
  delayMs: 750,
  requestBudget: budget,
});
const elapsedMs = Date.now() - started;

if (asJson) {
  console.log(JSON.stringify(profile, null, 2));
  process.exit(0);
}

// ── Readable report ──────────────────────────────────────────────────────
const { platform, server, api, jsonLd, protection, rendering, sitemap, robots, homepage } =
  profile;

console.log(`\n🔍 Website Intelligence — ${profile.origin}`);
console.log(
  `   ${profile.requests} polite requests · ${(elapsedMs / 1000).toFixed(1)}s\n`,
);

const row = (label, value, pad = 12) =>
  console.log(`  ${label.padEnd(pad)}${value}`);

row("PLATFORM", `${platform.name} (${platform.kind}) — ${platform.signal}`);
if (server) row("SERVER", server);
row(
  "API",
  `products.json: ${api.shopifyProductsJson} · graphql: ${api.graphql}` +
    (api.wooCommerce !== "unavailable"
      ? ` · woocommerce: ${api.wooCommerce}`
      : "") +
    (api.bigCommerce !== "unavailable"
      ? ` · bigcommerce: ${api.bigCommerce}`
      : ""),
);
row(
  "JSON-LD",
  `${jsonLd.blocks} block(s) · product on homepage: ${jsonLd.productOnHomepage ? "✓" : "—"} · product on product page: ${jsonLd.productOnProductPage ? "✓" : "—"} · priced: ${jsonLd.hasPrice ? "✓" : "—"}`,
);
row(
  "PROTECTION",
  `${protection.provider}${protection.blocking ? " ⚠️ blocking" : ""} — ${protection.evidence}`,
);
row(
  "RENDERING",
  `${rendering.verdict}${rendering.framework !== "plain" ? ` · framework: ${rendering.framework}` : ""}`,
);
row(
  "SITEMAP",
  sitemap.found
    ? `${sitemap.urls.toLocaleString()} product URL(s)${sitemap.productSitemap ? " · product sitemap ✓" : ""} — ${sitemap.source}`
    : sitemap.budgetLimited
      ? `walk budget-limited at ${profile.requests} requests (raise --budget to walk the full index)`
      : "not found",
);
row(
  "ROBOTS",
  `${robots.status}${robots.crawlDelayMs != null ? ` · crawl-delay ${robots.crawlDelayMs}ms` : ""}`,
);
row(
  "HOMEPAGE",
  `${homepage.looksLikeStore ? "store-like" : "corporate/marketing"} · ${homepage.productLinks} product link(s) · ${homepage.note}`,
);

console.log(`\n  ➜ RECOMMENDATION: ${profile.recommendation.tier}`);
for (const note of profile.recommendation.notes) {
  console.log(`      • ${note}`);
}
console.log("");
