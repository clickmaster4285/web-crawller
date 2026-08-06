import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Radar,
  Square,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ErrorState, LoadingState } from "@/components/common/states";
import { CancelCrawlDialog } from "@/components/crawls/cancel-crawl-dialog";
import {
  cancelCrawlJob,
  listActiveCrawlJobs,
  pauseCrawlJob,
  resumeCrawlJob,
  type CrawlJob,
} from "@/lib/crawl";
import { normalizeOrigin } from "@/utils/crawls";
import {
  notifyCrawlControl,
  notifyCrawlControlError,
  type CrawlControlAction,
  type CrawlControlVariables,
} from "@/utils/crawl-controls";

export const Route = createFileRoute("/_authenticated/crawler/")({
  head: () => ({
    meta: [
      { title: "Active crawls — Parity" },
      {
        name: "description",
        content:
          "Every crawl running in the background — pause, resume or cancel them from one place.",
      },
      { property: "og:title", content: "Active crawls — Parity" },
    ],
  }),
  component: CrawlerPage,
});

/** Compact "x s ago" / "x m y s ago" label for list timestamps. */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

/** Human label for a job's raw backend state. */
function stateLabel(state: CrawlJob["state"]): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "claimed":
      return "Running";
    case "retrying":
      return "Retrying";
    case "done":
      return "Done";
    case "failed":
    case "dead":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return state;
  }
}

function CrawlerPage() {
  const queryClient = useQueryClient();
  // Polled — the page is a live view of the crawl queue.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["active-crawl-jobs"],
    queryFn: () => listActiveCrawlJobs(),
    refetchInterval: 2500,
  });
  // Live clock so elapsed / "x ago" ticks every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["active-crawl-jobs"] });

  // The crawl being considered for cancellation (the confirmation dialog
  // target) — null while no dialog is open.
  const [cancelTarget, setCancelTarget] = useState<CrawlJob | null>(null);

  const control = useMutation({
    mutationFn: ({ id, action }: CrawlControlVariables) =>
      action === "pause"
        ? pauseCrawlJob({ data: id })
        : action === "resume"
          ? resumeCrawlJob({ data: id })
          : cancelCrawlJob({ data: id }),
    onSuccess: (_data, variables) => {
      refresh();
      // The cancel dialog stays open (showing its spinner) until the cancel
      // itself lands — a pause/resume settling must not dismiss an open
      // cancel confirmation.
      if (variables.action === "cancel") setCancelTarget(null);
      // Confirmation toast — visible no matter which page started the action.
      notifyCrawlControl(variables.action, variables.label, variables.id);
    },
    onError: (error, variables) =>
      notifyCrawlControlError(variables.action, error),
  });

  // True only while the confirmed cancel for the dialog's job is in flight
  // (a pending pause/resume on another card must not disable this dialog).
  const cancelling =
    control.isPending &&
    control.variables?.action === "cancel" &&
    control.variables?.id === cancelTarget?.id;

  const active = data?.active ?? [];
  const recent = data?.recent ?? [];
  const controlPendingId = control.isPending
    ? (control.variables?.id ?? null)
    : null;

  // Dismiss the dialog if its job vanished from the active list while the
  // user was deciding (it finished or was pruned) — cancelling a ghost job
  // would 404.
  const cancelTargetGone =
    cancelTarget != null && !active.some((j) => j.id === cancelTarget.id);
  useEffect(() => {
    if (cancelTargetGone) setCancelTarget(null);
  }, [cancelTargetGone, setCancelTarget]);

  if (isLoading) return <LoadingState label="Loading crawls…" />;
  if (isError && !data) return <ErrorState />;

  const act = (job: CrawlJob, action: CrawlControlAction) =>
    control.mutate({ id: job.id, action, label: job.origin });

  return (
    <div>
      <PageHeader
        title="Active crawls"
        description="Everything running in the background — pause, resume or cancel from one place. Crawls keep heartbeating to the server, so controls work from any tab."
      />

      <div className="space-y-8 px-6 py-8">
        {/* ── In-flight crawls ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="label-caps text-muted-foreground">
              In progress
              {active.length > 0 ? (
                <span className="ml-2 text-foreground">
                  {active.length} running
                </span>
              ) : null}
            </h2>
            <span className="text-xs text-muted-foreground">
              Refreshing every few seconds
            </span>
          </div>

          {active.length === 0 ? (
            <div className="flex flex-col items-center gap-2 border border-dashed border-border bg-muted/30 px-8 py-12 text-center">
              <Play className="size-6 text-muted-foreground/60" />
              <p className="text-sm font-medium">No crawls running</p>
              <p className="max-w-md text-xs text-muted-foreground">
                Start one from the{" "}
                <Link
                  to="/sources"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Crawler
                </Link>{" "}
                page, or schedule a recurring crawl — it appears here the moment
                it's enqueued.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {active.map((job) => {
                const paused = job.control === "pause";
                const pending = controlPendingId === job.id;
                const running = job.state === "claimed";
                return (
                  <article
                    key={job.id}
                    className="border border-border bg-card p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            to="/stores/$origin"
                            params={{ origin: normalizeOrigin(job.origin) }}
                            className="truncate font-medium hover:underline"
                          >
                            {job.origin.replace(/^https?:\/\//, "")}
                          </Link>
                          <Badge
                            variant={
                              job.type === "shallow" ? "secondary" : "outline"
                            }
                            className="gap-1 font-normal"
                          >
                            {job.type === "shallow" ? (
                              <Zap className="size-3" />
                            ) : (
                              <Radar className="size-3" />
                            )}
                            {job.type === "shallow"
                              ? "shallow check"
                              : "deep crawl"}
                          </Badge>
                          <Badge
                            variant={
                              paused
                                ? "secondary"
                                : running
                                  ? "outline"
                                  : "secondary"
                            }
                            className={
                              paused
                                ? "gap-1 border-amber-500/40 font-normal"
                                : "font-normal"
                            }
                          >
                            <span
                              className={
                                running && !paused
                                  ? "size-1.5 animate-pulse rounded-full bg-emerald-500"
                                  : "size-1.5 rounded-full bg-border"
                              }
                            />
                            {stateLabel(job.state)}
                            {paused ? " (paused)" : ""}
                          </Badge>
                          {job.control === "cancel" ? (
                            <Badge
                              variant="secondary"
                              className="border-red-500/40 font-normal"
                            >
                              Cancelling…
                            </Badge>
                          ) : null}
                        </div>{" "}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {job.startedAt > 0
                            ? `Started ${ago(Math.max(0, now - job.startedAt))}`
                            : "Just started"}
                          {job.params.useBrowser ? " · browser rendering" : ""}
                          {job.params.proxy ? " · residential proxy" : ""}
                        </p>
                        {/* Debug strip — worker id + live request count, so a
                            crawl can be traced to a worker and its HTTP cost
                            observed without opening worker logs. */}
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/70">
                          <span className="label-caps">Debug</span>
                          <span className="font-mono">
                            {job.workerId ?? "not claimed yet"}
                          </span>
                          <span>
                            {(job.requests ?? 0).toLocaleString()} request
                            {(job.requests ?? 0) === 1 ? "" : "s"}
                          </span>
                          {job.state === "retrying" ? (
                            <span className="text-amber-600">retrying…</span>
                          ) : null}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          className="h-7 text-muted-foreground"
                        >
                          <Link to="/sources" search={{ job: job.id }}>
                            <ExternalLink className="size-3.5" /> Track
                          </Link>
                        </Button>
                        {paused ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            disabled={pending}
                            onClick={() => act(job, "resume")}
                          >
                            {pending ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Play className="size-3.5" />
                            )}
                            Resume
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            disabled={pending}
                            onClick={() => act(job, "pause")}
                          >
                            {pending ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Pause className="size-3.5" />
                            )}
                            Pause
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7"
                          disabled={pending}
                          onClick={() => setCancelTarget(job)}
                        >
                          {pending ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Square className="size-3.5" />
                          )}
                          Cancel
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4">
                      {job.total > 0 ? (
                        <>
                          <Progress
                            value={Math.round(
                              (job.processed / job.total) * 100,
                            )}
                            aria-label="Crawl progress"
                          />
                          <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span className="numeric">
                              {job.processed.toLocaleString()} /{" "}
                              {job.total.toLocaleString()} products
                            </span>
                            <span className="numeric">
                              {Math.round((job.processed / job.total) * 100)}%
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          {paused
                            ? "Paused during discovery"
                            : `Discovering product URLs…${
                                job.discovery && job.discovery.urlsFound > 0
                                  ? ` ${job.discovery.urlsFound.toLocaleString()} found so far`
                                  : ""
                              }`}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Recently finished ────────────────────────────────────────── */}
        {recent.length > 0 ? (
          <section className="space-y-3">
            <h2 className="label-caps text-muted-foreground">
              Finished in the last 15 minutes
            </h2>
            <div className="divide-y divide-border border border-border bg-card">
              {recent.map((job) => {
                const done = job.state === "done";
                return (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {job.origin.replace(/^https?:\/\//, "")}
                    </span>
                    <Badge variant="secondary" className="gap-1 font-normal">
                      {job.type === "shallow" ? (
                        <Zap className="size-3" />
                      ) : (
                        <Radar className="size-3" />
                      )}
                      {job.type === "shallow" ? "shallow" : "deep"}
                    </Badge>
                    <Badge
                      variant={
                        done
                          ? "outline"
                          : job.state === "cancelled"
                            ? "secondary"
                            : "destructive"
                      }
                      className="font-normal"
                    >
                      {stateLabel(job.state)}
                    </Badge>{" "}
                    <span className="text-xs text-muted-foreground">
                      {done
                        ? `${job.processed.toLocaleString()} products · `
                        : ""}
                      {(job.requests ?? 0) > 0
                        ? `${(job.requests ?? 0).toLocaleString()} requests · `
                        : ""}
                      {job.finishedAt
                        ? ago(Math.max(0, now - job.finishedAt))
                        : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      {/* Cancel confirmation — a stop is irreversible (nothing persisted). */}
      <CancelCrawlDialog
        job={cancelTarget}
        cancelling={cancelling}
        onConfirm={() => {
          if (cancelTarget) act(cancelTarget, "cancel");
        }}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
