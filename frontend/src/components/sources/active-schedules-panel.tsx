import { SectionTitle } from "@/components/cards/stat-card";
import { Button } from "@/components/ui/button";
import type { CrawlFrequency, CrawlSchedule } from "@/lib/crawl";

function frequencyLabel(frequency: CrawlFrequency): string {
  switch (frequency) {
    case "1h":
      return "hour";
    case "6h":
      return "6 hours";
    case "daily":
      return "day";
    case "weekly":
      return "week";
  }
}

function formatScheduleTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** Active recurring-crawl schedules — with an offline fallback note. */
export function ActiveSchedulesPanel({
  schedules,
  offline,
  onCancel,
  cancelPending,
}: {
  schedules: CrawlSchedule[];
  /** True when the live query failed and `schedules` is the cached copy. */
  offline: boolean;
  onCancel: (origin: string) => void;
  cancelPending: boolean;
}) {
  return (
    <>
      {offline ? (
        <p className="text-xs text-muted-foreground">
          Server unreachable — showing the last known schedules from memory.
          Recurring crawls persist server-side; they'll resync when the
          connection returns.
        </p>
      ) : null}
      {schedules.length > 0 ? (
        <section>
          <SectionTitle>Active schedules</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {schedules.map((s) => (
              <li
                key={s.origin}
                className="flex items-center justify-between gap-3 p-3.5 text-sm"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono">{s.origin}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Every {frequencyLabel(s.frequency)} · next run{" "}
                    {formatScheduleTime(s.nextRunAt)} ·{" "}
                    {s.running
                      ? "running"
                      : s.lastRunAt
                        ? `last ran ${formatScheduleTime(s.lastRunAt)}`
                        : "never ran"}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onCancel(s.origin)}
                  disabled={cancelPending}
                >
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
