import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export function EmptyState({
  title,
  description,
  actionLabel = "Add a competitor",
  actionTo = "/competitors",
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
}) {
  return (
    <div className="mx-6 my-10 border border-dashed border-border bg-card p-10 text-center">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <Button asChild className="mt-6">
        <Link to={actionTo}>{actionLabel}</Link>
      </Button>
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
    <div className="mx-6 my-10 border border-dashed border-destructive/40 bg-card p-10 text-center">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
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
    <div className="mx-6 my-10 border border-dashed border-border bg-card p-10 text-center">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <Button asChild className="mt-6">
        <Link to="/sources">Run a crawl</Link>
      </Button>
    </div>
  );
}
