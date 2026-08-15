import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  Cpu,
  Gauge,
  Globe,
  RefreshCw,
  ShieldAlert,
  Timer,
  TriangleAlert,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState, LoadingState } from "@/components/common/states";
import { useMetrics } from "@/hooks/useData";
import { formatDuration } from "@/utils/format";
import { normalizeOrigin } from "@/utils/crawls";

export const Route = createFileRoute("/_authenticated/metrics/")({
  head: () => ({
    meta: [
      { title: "Metrics — Parity" },
      {
        name: "description",
        content:
          "Crawl-queue health: live queue depth, worker liveness and 24h/7d throughput.",
      },
      { property: "og:title", content: "Metrics — Parity" },
    ],
  }),
  component: MetricsPage,
});

/** Small labelled stat tile used across the page. */
function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-500"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-destructive"
          : "text-foreground";
  return (
    <Card className="p-4">
      <p className="label-caps text-muted-foreground">{label}</p>
      <p className={`numeric mt-1 font-display text-2xl ${toneClass}`}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      ) : null}
    </Card>
  );
}

/** Formats a percent (already 0–100) with a sign-less label. */
function pctLabel(n: number | undefined | null): string {
  if (n == null) return "—";
  return `${n}%`;
}

/** Formats ms as a readable duration (e.g. 12m 3s). */
function dur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const d = formatDuration(ms);
  // formatDuration gives m:ss — expand to h when long.
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec >= 3600) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  return d;
}

function MetricsPage() {
  const { data, isLoading, isError } = useMetrics();
  // Live clock for the "generated Xs ago" ticker.
  const now = Date.now();

  if (isLoading) return <LoadingState label="Loading metrics…" />;
  if (isError && !data) return <ErrorState />;

  const m = data?.data;
  if (!m) return <ErrorState />;

  const q = m.queue;
  const w = m.workers;
  const t24 = m.throughput.last24h;
  const t7 = m.throughput.last7d;
  const generatedAgo = Math.max(
    0,
    Math.floor((now - new Date(m.generatedAt).getTime()) / 1000),
  );

  const queueTotal = q.done + q.failed + q.dead + q.cancelled + q.inFlight;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Metrics"
        description="Crawl-queue health — live queue depth, worker liveness and throughput, all derived from the CrawlJob collection."
      />

      <div className="space-y-8 px-6 py-8">
        {/* ── Queue depth ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="label-caps text-muted-foreground">
              Queue <span className="ml-1 font-normal">{queueTotal} jobs</span>
            </h2>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <RefreshCw className="size-3" />
              refreshed {generatedAgo}s ago
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <Stat
              label="In flight"
              value={q.inFlight.toLocaleString()}
              sub="queued + running"
              tone={q.inFlight > 0 ? "good" : "default"}
            />
            <Stat label="Queued" value={q.queued.toLocaleString()} />
            <Stat
              label="Claimed"
              value={q.claimed.toLocaleString()}
              tone={q.claimed > 0 ? "good" : "default"}
            />
            <Stat
              label="Retrying"
              value={q.retrying.toLocaleString()}
              tone={q.retrying > 0 ? "warn" : "default"}
            />
            <Stat label="Done" value={q.done.toLocaleString()} tone="good" />
            <Stat
              label="Failed"
              value={q.failed.toLocaleString()}
              tone={q.failed > 0 ? "warn" : "default"}
            />
            <Stat
              label="Dead"
              value={q.dead.toLocaleString()}
              tone={q.dead > 0 ? "bad" : "default"}
            />
            <Stat label="Cancelled" value={q.cancelled.toLocaleString()} />
          </div>
        </section>

        {/* ── Workers ─────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="label-caps text-muted-foreground">
            Workers{" "}
            <span className="ml-1 font-normal">
              {w.aliveCount} alive · {w.activeCount} holding jobs
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label="Alive"
              value={w.aliveCount.toLocaleString()}
              sub={`of ${w.activeCount} active`}
              tone={w.aliveCount > 0 ? "good" : "warn"}
            />
            <Stat
              label="Stale claims"
              value={w.staleClaims.toLocaleString()}
              sub={`heartbeat > ${Math.round(w.heartbeatTimeoutMs / 1000)}s`}
              tone={w.staleClaims > 0 ? "bad" : "default"}
            />
            <Stat
              label="Schedules"
              value={m.schedules.active.toLocaleString()}
              sub="recurring crawls enabled"
            />
          </div>

          {w.active.length > 0 ? (
            <Card className="divide-y divide-border">
              {w.active.map((worker) => (
                <div
                  key={worker.workerId}
                  className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
                >
                  <Badge
                    variant="secondary"
                    className={
                      worker.alive
                        ? "gap-1 border-emerald-500/30 font-mono text-[11px] font-normal"
                        : "gap-1 border-amber-500/40 font-mono text-[11px] font-normal text-amber-600"
                    }
                  >
                    {worker.alive ? (
                      <Cpu className="size-3 text-emerald-500" />
                    ) : (
                      <TriangleAlert className="size-3" />
                    )}
                    {worker.workerId}
                  </Badge>
                  {worker.jobs.map((job) => (
                    <span
                      key={job.jobId}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted-foreground"
                    >
                      <Globe className="size-3 shrink-0" />
                      <Link
                        to="/stores/$origin"
                        params={{ origin: normalizeOrigin(job.origin) }}
                        className="truncate font-medium text-foreground hover:underline"
                      >
                        {job.origin.replace(/^https?:\/\//, "")}
                      </Link>
                      <Badge variant="outline" className="gap-1 font-normal">
                        {job.type === "shallow" ? (
                          <Zap className="size-3" />
                        ) : (
                          <Activity className="size-3" />
                        )}
                        {job.type}
                      </Badge>
                    </span>
                  ))}
                </div>
              ))}
            </Card>
          ) : (
            <EmptyState
              icon={Cpu}
              title="No worker holds a job"
              description="The queue is idle — start a crawl on the Sources page and the claiming worker appears here."
            />
          )}
        </section>

        {/* ── Throughput: 24h / 7d ────────────────────────────────────── */}
        {[t24, t7].map((t, i) => (
          <section key={i} className="space-y-3">
            <h2 className="label-caps text-muted-foreground">
              {i === 0 ? "Last 24 hours" : "Last 7 days"}
              <span className="ml-1 font-normal">
                · {t.total} finished · {t.requests.toLocaleString()} requests
              </span>
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              <Stat
                label="Finished"
                value={t.total.toLocaleString()}
                sub={`${t.byType.deep} deep · ${t.byType.shallow} shallow`}
              />
              <Stat
                label="Success rate"
                value={pctLabel(t.successRate)}
                tone={
                  t.successRate >= 90
                    ? "good"
                    : t.successRate >= 60
                      ? "warn"
                      : "bad"
                }
              />
              <Stat
                label="Failure rate"
                value={pctLabel(t.failureRate)}
                tone={
                  t.failureRate > 20
                    ? "bad"
                    : t.failureRate > 0
                      ? "warn"
                      : "default"
                }
              />
              <Stat
                label="Avg duration"
                value={dur(t.durations.avgMs)}
                sub="finished jobs"
              />
              <Stat
                label="Median"
                value={dur(t.durations.medianMs)}
                sub={`p95 ${dur(t.durations.p95Ms)}`}
              />
              <Stat
                label="Failed avg"
                value={dur(t.failedDurations.avgMs)}
                sub={
                  t.failedDurations.count > 0
                    ? `${t.failedDurations.count} failed`
                    : "no failures"
                }
                tone={t.failedDurations.count > 0 ? "warn" : "default"}
              />
            </div>
          </section>
        ))}

        {/* ── Legend / about ──────────────────────────────────────────── */}
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Gauge className="size-3.5" /> Derived live from CrawlJob — no
            counters to maintain
          </span>
          <span className="flex items-center gap-1.5">
            <Timer className="size-3.5" /> Heartbeat timeout{" "}
            {Math.round(w.heartbeatTimeoutMs / 1000)}s
          </span>
          <span className="flex items-center gap-1.5">
            <ShieldAlert className="size-3.5" /> Stale claims are released and
            requeued
          </span>
        </Card>
      </div>
    </div>
  );
}
