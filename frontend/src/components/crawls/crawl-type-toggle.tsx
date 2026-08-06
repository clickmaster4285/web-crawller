import { Radar, Zap } from "lucide-react";

import { cn } from "@/lib/utils";

/** Crawl-type filter for the saved-crawls list. */
export type TypeFilter = "all" | "shallow" | "deep";

/** Toggle options with real per-type counts (shown even while filtered). */
function typeFilterOptions(counts: { shallow: number; deep: number }) {
  return [
    { value: "all" as const, label: "All", icon: null, count: null },
    {
      value: "shallow" as const,
      label: "Shallow checks",
      icon: <Zap className="size-3.5 text-amber-500" />,
      count: counts.shallow,
    },
    {
      value: "deep" as const,
      label: "Deep crawls",
      icon: <Radar className="size-3.5" />,
      count: counts.deep,
    },
  ];
}

/** Segmented All / Shallow checks / Deep crawls toggle with live counts. */
export function CrawlTypeToggle({
  value,
  onChange,
  counts,
}: {
  value: TypeFilter;
  onChange: (value: TypeFilter) => void;
  counts: { shallow: number; deep: number };
}) {
  return (
    <div
      role="group"
      aria-label="Filter by crawl type"
      className="flex items-center gap-1 rounded-md border border-border bg-card p-1"
    >
      {typeFilterOptions(counts).map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          aria-pressed={value === t.value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors",
            value === t.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {t.icon}
          {t.label}
          {t.count != null ? (
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] leading-4",
                value === t.value
                  ? "bg-primary-foreground/15 text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {t.count.toLocaleString()}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
