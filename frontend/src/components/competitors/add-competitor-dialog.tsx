import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Globe, Loader2, Plus, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createCompetitor } from "@/lib/api";
import { toOriginUrl } from "@/utils/crawls";

export function AddCompetitorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");

  const add = useMutation({
    mutationFn: (input: { name: string; origin: string }) =>
      createCompetitor(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["competitors"] });
      setName("");
      setOrigin("");
      onOpenChange(false);
    },
  });

  const submit = () => {
    const normalized = toOriginUrl(origin);
    if (!/^https?:\/\/\S+$/i.test(normalized)) return;
    add.mutate({ name: name.trim(), origin: normalized });
  };

  const errorMessage =
    add.error instanceof Error ? add.error.message : String(add.error ?? "");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName("");
          setOrigin("");
          add.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a competitor</DialogTitle>
          <DialogDescription>
            Enter the store you want to monitor. It's added to your list
            immediately; run a crawl to start capturing its catalogue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="competitor-name">
              Display name{" "}
              <span className="font-normal text-muted-foreground">
                (optional — derived from the domain if blank)
              </span>
            </Label>
            <Input
              id="competitor-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. OB Designs"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="competitor-origin">Store domain</Label>
            <Input
              id="competitor-origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="store.example.com or https://store.example.com"
              className="font-mono"
            />
          </div>
        </div>

        {add.isError ? (
          <p className="flex items-center gap-2 text-xs text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" /> {errorMessage}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={add.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={add.isPending || !toOriginUrl(origin)}
          >
            {add.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Globe className="size-4" />
            )}
            Add competitor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
