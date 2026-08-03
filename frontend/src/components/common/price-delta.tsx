import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";

/** Colored price delta (+ / −) with a direction arrow. */
export function PriceDelta({
  before,
  after,
}: {
  before: number;
  after: number;
}) {
  const delta = after - before;
  if (delta === 0) {
    return <span className="numeric text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn(
        "numeric inline-flex items-center gap-1",
        delta > 0 ? "text-destructive" : "text-success",
      )}
    >
      {delta > 0 ? (
        <ArrowUp className="size-3.5" />
      ) : (
        <ArrowDown className="size-3.5" />
      )}
      {delta > 0 ? "+" : ""}
      {delta.toLocaleString("en-US", { maximumFractionDigits: 2 })}
    </span>
  );
}
