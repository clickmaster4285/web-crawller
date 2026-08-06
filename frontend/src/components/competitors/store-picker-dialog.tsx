import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search, Store } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatCrawlDate } from "@/utils/crawls";
import { cn } from "@/lib/utils";

/** A crawled website in the picker — lightweight metadata only (no products). */
export interface StoreOption {
  /** Normalized host key (used for slot selection / exclusions). */
  key: string;
  /** Full origin URL — what the crawler and "your website" setting use. */
  origin: string;
  productCount: number;
  platform: string | null;
  updatedAt: string;
}

/**
 * Searchable list of crawled websites. Used both to set "your website" and to
 * fill a competitor slot. Built from lightweight crawl summaries (`?meta=1`),
 * so opening it never downloads the full product catalogues.
 */
export function StorePickerDialog({
  open,
  onOpenChange,
  stores,
  excludeKeys,
  onSelect,
  title = "Choose a website",
  description = "Pick a store you've crawled — its catalogue is used for the comparison.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Websites to choose from (each is a lightweight crawl summary). */
  stores: StoreOption[];
  /** Keys that must not be selectable (your store, slots already filled). */
  excludeKeys: string[];
  onSelect: (origin: string) => void;
  title?: string;
  description?: string;
}) {
  const [query, setQuery] = useState("");

  const excluded = useMemo(() => new Set(excludeKeys), [excludeKeys]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return stores
      .filter((s) => !excluded.has(s.key))
      .filter(
        (s) => !q || s.origin.toLowerCase().includes(q) || s.key.includes(q),
      )
      .sort((a, b) => b.productCount - a.productCount);
  }, [stores, excluded, query]);

  const close = () => {
    setQuery("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search domains…"
            className="pl-9"
            autoFocus
          />
        </div>

        <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              {query
                ? `No crawled store matches “${query}”.`
                : "No crawled stores to choose from yet."}
            </p>
          ) : (
            filtered.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  onSelect(s.origin);
                  close();
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors",
                  "hover:border-border hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <Store className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.key}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.platform ?? "Unknown platform"}
                    {" · "}
                    Crawled {formatCrawlDate(s.updatedAt)}
                  </span>
                </span>
                <Badge variant="secondary" className="shrink-0 font-normal">
                  {s.productCount.toLocaleString()} products
                </Badge>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            Don't see a store? Run a crawl first — every saved crawl becomes a
            selectable website here.
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={close}
          >
            <Link to="/sources">Run a crawl</Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
