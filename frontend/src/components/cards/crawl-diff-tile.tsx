import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/** Colored change tile: new products / removed / price changed between runs. */
export function CrawlDiffTile({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone?: "success" | "destructive" | "warning" | "neutral";
}) {
  return (
    <Card className="p-3">
      <p
        className={cn(
          "numeric text-xl",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </Card>
  );
}
