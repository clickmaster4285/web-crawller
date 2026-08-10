import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The tinted store pill used across the Competitors surface — a colored dot
 * (or an optional leading icon) + truncated label. "mine" = ink primary
 * (your website), "competitor" = amber accent (competitor slots / the
 * competitor side of a comparison), "muted" = neutral meta. One source of
 * truth for the pill look, so the page header and the match rows read as a
 * single design language.
 */
export function StorePill({
  label,
  tone = "muted",
  icon: Icon,
  className,
}: {
  label: string;
  tone?: "mine" | "competitor" | "muted";
  /** Optional leading icon — replaces the colored dot when provided. */
  icon?: LucideIcon;
  className?: string;
}) {
  const tones = {
    mine: {
      pill: "border-primary/20 bg-primary/10 text-primary",
      dot: "bg-primary",
    },
    competitor: {
      pill: "border-accent/30 bg-accent/15 text-accent",
      dot: "bg-accent",
    },
    muted: {
      pill: "border-border bg-muted/40 text-muted-foreground",
      dot: "bg-muted-foreground/50",
    },
  } as const;
  const t = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        t.pill,
        className,
      )}
      title={label}
    >
      {Icon ? (
        <Icon className="size-3 shrink-0" />
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
