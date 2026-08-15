import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * EmptyState — one consistent \"nothing here yet\" treatment for every page
 * (icon on a soft tile, title, description, optional action). Replaces the
 * scattered plain-text empty states so a missing dataset reads as designed,
 * not as an error.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 border border-dashed border-border bg-muted/30 px-8 py-14 text-center",
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-full border border-border bg-card">
        <Icon className="size-5 text-muted-foreground/70" />
      </span>
      <p className="mt-1 text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
