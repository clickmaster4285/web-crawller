import { toast } from "sonner";

/** Actions the crawl-control endpoints accept. */
export type CrawlControlAction = "pause" | "resume" | "cancel";

/** Mutation variables for the crawl-control mutation (both control surfaces). */
export interface CrawlControlVariables {
  id: string;
  action: CrawlControlAction;
  /** Store origin — shown in the confirmation toast when known. */
  label?: string;
}

/** Bare host (no protocol) for toast labels, e.g. "athletix.ae". */
function hostLabel(origin?: string): string | undefined {
  if (!origin) return undefined;
  return origin.replace(/^https?:\/\//, "");
}

/**
 * Confirmation toast after a successful pause/resume/cancel — fires from both
 * control surfaces (Active crawls + the Sources live panel), so the outcome is
 * visible no matter where the user acted. Cancel is phrased as a warning
 * because it is irreversible (nothing is persisted).
 *
 * `jobId` keys the toast: a quick pause → resume on the same job replaces the
 * pause toast instead of stacking a second one.
 */
export function notifyCrawlControl(
  action: CrawlControlAction,
  origin?: string,
  jobId?: string,
) {
  const who = hostLabel(origin);
  const id = `crawl-control-${jobId ?? "unknown"}`;
  switch (action) {
    case "pause":
      toast("Crawl paused", {
        id,
        description: who
          ? `${who} — resume it anytime from Active crawls.`
          : "Resume it anytime from Active crawls.",
      });
      break;
    case "resume":
      toast.success("Crawl resumed", {
        id,
        description: who
          ? `${who} is picking up where it left off.`
          : "Picking up where it left off.",
      });
      break;
    case "cancel":
      toast.warning("Crawl cancelled", {
        id,
        description: who
          ? `${who} — no partial result was saved.`
          : "No partial result was saved.",
      });
      break;
  }
}

/** Error toast when a pause/resume/cancel request fails. */
export function notifyCrawlControlError(
  action: CrawlControlAction,
  error: unknown,
) {
  toast.error(`Couldn't ${action} the crawl`, {
    description: error instanceof Error ? error.message : String(error),
  });
}
