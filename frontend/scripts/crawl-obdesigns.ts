/**
 * Standalone crawl script for the OB Designs USA store.
 *
 * Run: npm run crawl
 * Writes: src/data/crawled/obdesigns-silicone-toys.json
 *
 * Note: executed with plain `node` (Node >=22.6 strips types). Imports must
 * use explicit `.ts` extensions and must not rely on the `@/` alias.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCrawl } from "../src/lib/crawler/index.ts";

const origin = "https://obdesignsusa.com";
const collection = "silicone-toys";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await runCrawl({
  origin,
  collections: [collection],
  delayMs: 1500,
  maxRetries: 4,
  // SQLite checkpoint — re-runs skip unchanged products (gitignored).
  checkpointPath: join(root, ".crawler", "obdesigns.checkpoint.db"),
  onProgress: (fetched, discovered) => {
    process.stdout.write(`\rFetched ${fetched}/${discovered}`);
  },
});

const outDir = join(root, "src", "data", "crawled");
await mkdir(outDir, { recursive: true });

const outFile = join(outDir, "obdesigns-silicone-toys.json");
await writeFile(outFile, JSON.stringify(result, null, 2), "utf8");

process.stdout.write("\n");
console.log(
  `Crawled ${result.products.length} products from ${origin}/${collection}`,
);
console.log(
  `Discovered ${result.stats.discovered}, fetched ${result.stats.fetched}, ` +
    `skipped-unchanged ${result.stats.skippedUnchanged}, failed ${result.stats.failed} ` +
    `in ${result.stats.durationMs}ms`,
);
console.log(`Wrote ${outFile}`);

if (result.stats.failed > 0) {
  console.error("Failures:");
  for (const failure of result.stats.failures) {
    console.error(`  - ${failure.url}: ${failure.error}`);
  }
  process.exitCode = 1;
}
