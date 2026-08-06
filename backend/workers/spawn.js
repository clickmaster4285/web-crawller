/**
 * spawn — dev convenience: starts the crawl worker(s) + scheduler as child
 * processes alongside the API so the app works out of the box (architecture
 * D4: workers are separate processes; the API only enqueues and reports).
 *
 * Env knobs:
 *   PARITY_INFRA=0        disable entirely (run workers manually)
 *   PARITY_WORKERS=N      worker processes to spawn (default min(3, CPU cores)
 *                         in dev so queued crawls run in parallel, 0 in prod)
 *   PARITY_SCHEDULER=0/1  spawn the scheduler (default on in dev, off in prod)
 *
 * Production deployments should run `npm run worker` (N instances) and
 * `npm run scheduler` (single instance) under their own process manager
 * instead of relying on this spawner.
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const BACKEND_ROOT = path.join(__dirname, '..');
const children = new Set();
let shuttingDown = false;

function spawnProcess(label, script, env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, script)], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  children.add(child);
  let failures = 0;
  let aliveSince = Date.now();
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    // Capped exponential backoff on crashes (3s → 6s → 12s → … → 30s) so a
    // Mongo outage doesn't turn into a 3s crash-loop; a child that stayed up
    // for a minute resets the counter.
    if (Date.now() - aliveSince > 60_000) failures = 0;
    const delay = Math.min(3000 * 2 ** failures, 30_000);
    failures++;
    console.error(`[crawl-infra] ${label} exited (code=${code} signal=${signal}) — respawning in ${delay / 1000}s`);
    setTimeout(() => {
      if (!shuttingDown) spawnProcess(label, script, env);
    }, delay);
  });
  child.on('spawn', () => {
    aliveSince = Date.now();
  });
  child.on('error', (err) => {
    console.error(`[crawl-infra] ${label} failed to start: ${err.message}`);
  });
  return child;
}

function spawnCrawlInfra() {
  if (process.env.PARITY_INFRA === '0') {
    console.log('[crawl-infra] disabled (PARITY_INFRA=0) — run `npm run worker` manually');
    return;
  }
  const isProd = process.env.NODE_ENV === 'production';
  // Dev default: a handful of workers so several queued crawls progress in
  // parallel (one worker serializes every job, and deep crawls of 10k-product
  // stores take tens of minutes each). Each worker is a separate process;
  // jobs are claimed atomically so they never double-run.
  const devWorkers = Math.min(3, os.cpus().length || 1);
  const workerCount = Number(
    process.env.PARITY_WORKERS ?? (isProd ? 0 : devWorkers)
  );
  const schedulerOn =
    process.env.PARITY_SCHEDULER != null
      ? process.env.PARITY_SCHEDULER === '1'
      : !isProd;

  for (let i = 1; i <= workerCount; i++) {
    spawnProcess(`worker ${i}`, 'worker.mjs', { PARITY_WORKER_ID: `worker-${i}` });
  }
  if (schedulerOn) {
    spawnProcess('scheduler', 'scheduler.mjs');
  }
  if (workerCount > 0 || schedulerOn) {
    console.log(
      `[crawl-infra] spawned ${workerCount} worker(s)${schedulerOn ? ' + scheduler' : ''} — ` +
        'crawls now run in separate processes (queue: CrawlJob). ' +
        'Disable with PARITY_INFRA=0.'
    );
  }
}

// Kill children when the API exits so no orphaned crawlers survive a restart.
process.on('exit', () => {
  shuttingDown = true;
  for (const child of children) child.kill();
});
process.on('SIGINT', () => {
  shuttingDown = true;
  for (const child of children) child.kill();
});
process.on('SIGTERM', () => {
  shuttingDown = true;
  for (const child of children) child.kill();
});

module.exports = { spawnCrawlInfra };
