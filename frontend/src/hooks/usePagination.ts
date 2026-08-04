import { useEffect, useMemo, useState } from "react";

/**
 * Client-side pagination for in-memory lists. Slices `items` down to a page
 * and keeps the page in range. The page resets to 1 whenever the total row
 * count changes (search, filter, snapshot switch) and clamps when the set
 * shrinks below the current page.
 */
export function usePagination<T>(items: T[], pageSize = 50) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(pageSize);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));

  // Jump back to the first page whenever the result set changes. Any stale
  // page beyond the last is clamped at render time below, so no extra effect
  // is needed (and the two effects would otherwise race on list shrink).
  useEffect(() => {
    setPage(1);
  }, [total]);

  const pageItems = useMemo(() => {
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * size;
    return items.slice(start, start + size);
  }, [items, page, size, totalPages]);

  const setPageSize = (next: number) => {
    setSize(next);
    setPage(1);
  };

  return {
    page,
    setPage,
    pageSize: size,
    setPageSize,
    totalPages,
    total,
    pageItems,
  };
}
