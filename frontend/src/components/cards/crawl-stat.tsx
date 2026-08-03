import { cn } from "@/lib/utils";

/** Small stat tile (value + label) used in crawl results and saved-crawl details. */
export function CrawlStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="border border-border bg-card p-3">
      <p className="numeric text-xl" aria-label={label}>
        {value}
      </p>
      <p
        className={cn(
          "mt-0.5 text-xs",
          accent ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </p>
    </div>
  );
}
