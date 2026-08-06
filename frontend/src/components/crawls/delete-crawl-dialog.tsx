import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Delete-confirmation target: a single snapshot or a store's whole history. */
export type ConfirmTarget =
  | { kind: "id"; id: string; origin: string }
  | { kind: "origin"; origin: string; count: number };

/** Confirmation dialog for deleting one snapshot or clearing a store's history. */
export function DeleteCrawlDialog({
  target,
  deleting,
  onConfirm,
  onCancel,
}: {
  target: ConfirmTarget | null;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target?.kind === "origin"
              ? "Clear this store's history?"
              : "Delete this snapshot?"}
          </DialogTitle>
          <DialogDescription className="break-words">
            {target?.kind === "origin" ? (
              <>
                All {target.count} saved snapshot
                {target.count === 1 ? "" : "s"} for{" "}
                <span className="font-mono">{target.origin}</span> will be
                removed. You can always re-crawl the store later.
              </>
            ) : (
              <>
                The snapshot of{" "}
                <span className="font-mono">{target?.origin}</span> will be
                removed from your saved crawls.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deleting} onClick={onConfirm}>
            {deleting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
