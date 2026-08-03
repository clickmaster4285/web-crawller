import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The standard dashed-card state shell used for loading/empty/error
 * messages across pages. Override the margins with `className` where a
 * page's layout differs (e.g. `mx-6 mb-8`).
 */
export function StateCard({
  title,
  description,
  icon,
  action,
  destructive = false,
  className,
}: {
  title: string;
  description: ReactNode;
  /** Optional icon rendered above the title. */
  icon?: ReactNode;
  /** Optional action row (buttons / links) rendered below the text. */
  action?: ReactNode;
  destructive?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-6 border border-dashed bg-card p-10 text-center",
        destructive ? "border-destructive/40" : "border-border",
        className,
      )}
    >
      {icon ? <div className="mb-3 flex justify-center">{icon}</div> : null}
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action ? (
        <div className="mt-6 flex flex-wrap justify-center gap-3">{action}</div>
      ) : null}
    </div>
  );
}

export function LoadingState({
  label = "Loading live data…",
}: {
  label?: string;
}) {
  return (
    <div className="px-6 py-16 text-center text-sm text-muted-foreground">
      <span className="inline-block size-2 animate-pulse rounded-full bg-accent" />{" "}
      {label}
    </div>
  );
}

export function ErrorState({
  title = "Couldn't load data",
  description = "The server request failed. Check that the API is reachable, then try again.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <StateCard
      destructive
      title={title}
      description={description}
      className="my-10"
    />
  );
}

/**
 * Shown when a page's endpoint has no real data source yet (or no crawls
 * have been saved). The demo dataset was removed, so pages must never show
 * fabricated numbers — only this honest state until real data exists.
 */
export function NoRealDataState({
  title = "No real data yet",
  description = "This view needs data this build doesn't produce yet. Run a crawl on the Sources page to see real captured data here once the matching/analysis layer lands.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <StateCard
      className="my-10"
      title={title}
      description={description}
      action={
        <Button asChild>
          <Link to="/sources">Run a crawl</Link>
        </Button>
      }
    />
  );
}
