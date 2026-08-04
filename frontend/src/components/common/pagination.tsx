import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface PaginationBarProps {
  /** Current 1-based page. */
  page: number;
  totalPages: number;
  /** Total row count across all pages. */
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** When provided, renders the "rows per page" selector. */
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

const DEFAULT_PAGE_SIZES = [25, 50, 100];

/** Windowed page-number list, e.g. `1 … 4 5 6 … 20`. */
function pageWindow(page: number, totalPages: number): Array<number | "…"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages: Array<number | "…"> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) pages.push("…");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < totalPages - 1) pages.push("…");
  pages.push(totalPages);
  return pages;
}

/**
 * Row count + page-size selector + Prev/Next + numbered pages. Self-contained
 * and unstyled against any particular table — pair it with `usePagination`.
 */
export function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  className,
}: PaginationBarProps) {
  if (total <= 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground">
          Showing{" "}
          <span className="numeric font-medium text-foreground">
            {from.toLocaleString()}–{to.toLocaleString()}
          </span>{" "}
          of{" "}
          <span className="numeric font-medium text-foreground">
            {total.toLocaleString()}
          </span>
        </p>
        {onPageSizeChange ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Rows</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
            >
              <SelectTrigger
                aria-label="Rows per page"
                className="h-7 w-16 px-2 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
      </div>

      <nav className="flex items-center gap-1" aria-label="Pagination">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
          <span className="hidden sm:inline">Prev</span>
        </Button>
        {pageWindow(page, totalPages).map((p, i) =>
          p === "…" ? (
            <span
              key={`gap-${i}`}
              className="px-1 text-xs text-muted-foreground"
            >
              …
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? "default" : "outline"}
              size="sm"
              className="h-7 w-7 p-0 text-xs"
              aria-current={p === page ? "page" : undefined}
              onClick={() => onPageChange(p)}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-3.5" />
        </Button>
      </nav>
    </div>
  );
}
