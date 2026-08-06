import { Loader2, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CrawlJob } from "@/lib/crawl";

/**
 * Confirmation dialog before cancelling a crawl — a cancel stops the run at
 * the next checkpoint and **nothing is persisted**, so it deserves a
 * confirm rather than a one-click destructive action.
 */
export function CancelCrawlDialog({
  job,
  cancelling,
  onConfirm,
  onCancel,
}: {
  job: CrawlJob | null;
  /** True while the cancel request is in flight (buttons disabled + spinner). */
  cancelling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const display = job?.origin.replace(/^https?:\/\//, "") ?? "";
  return (
    <Dialog
      open={job != null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel this crawl?</DialogTitle>
          <DialogDescription className="break-words">
            The{" "}
            <span className="font-medium text-foreground">
              {job?.type === "shallow" ? "shallow check" : "deep crawl"}
            </span>{" "}
            of <span className="font-mono">{display}</span> will be stopped
            right away —{" "}
            <span className="font-medium">no partial result is saved</span>, so
            the catalogue won't be left half-updated. You can start a new crawl
            whenever you're ready.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={cancelling}>
            Keep crawling
          </Button>
          <Button
            variant="destructive"
            disabled={cancelling}
            onClick={onConfirm}
          >
            {cancelling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-4" />
            )}
            Cancel crawl
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
