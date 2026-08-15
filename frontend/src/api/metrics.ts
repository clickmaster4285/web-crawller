import { http } from "@/lib/http";

/** One window's finished-job summary (24h / 7d). */
export interface ThroughputWindow {
  total: number;
  byStatus: {
    done: number;
    failed: number;
    dead: number;
    cancelled: number;
  };
  byType: {
    deep: number;
    shallow: number;
  };
  successRate: number;
  failureRate: number;
  durations: {
    count: number;
    avgMs: number | null;
    medianMs: number | null;
    p95Ms: number | null;
  };
  failedDurations: {
    count: number;
    avgMs: number | null;
  };
  /** Total HTTP requests reported by jobs in the window. */
  requests: number;
}

/** A worker currently holding a claimed crawl job. */
export interface ActiveWorker {
  workerId: string;
  alive: boolean;
  jobs: Array<{ jobId: string; origin: string; type: string }>;
}

/** `GET /api/data/metrics` — the crawl-job health snapshot. */
export interface CrawlMetrics {
  generatedAt: string;
  queue: {
    queued: number;
    claimed: number;
    retrying: number;
    done: number;
    failed: number;
    dead: number;
    cancelled: number;
    inFlight: number;
  };
  workers: {
    active: ActiveWorker[];
    activeCount: number;
    aliveCount: number;
    staleClaims: number;
    heartbeatTimeoutMs: number;
  };
  throughput: {
    last24h: ThroughputWindow;
    last7d: ThroughputWindow;
  };
  schedules: {
    active: number;
  };
}

/** Fetches the crawl-job metrics snapshot from the server API. */
export const getMetricsData = () =>
  http.get<{ success: boolean; data: CrawlMetrics }>("/data/metrics");
