import type { ReactNode } from "react";

import { CrawlDiffTile } from "@/components/cards/crawl-diff-tile";
import { ProductCell } from "@/components/common/product-cell";
import { StockBadge } from "@/components/common/stock-badge";
import { formatPrice } from "@/utils/format";

export interface DiffProduct {
  name: string;
  url: string;
  price: number;
  available: boolean;
}

/** Product rows found in this run but not the previous one (max `limit`). */
export function NewProductsList({
  products,
  limit = 6,
  title,
  footer,
}: {
  products: DiffProduct[];
  limit?: number;
  /** Optional heading rendered above the list. */
  title?: string;
  /** Optional trailing "…and N more" line. */
  footer?: ReactNode;
}) {
  if (products.length === 0) return null;
  return (
    <div className="mt-3">
      {title ? (
        <p className="mb-2 text-xs text-muted-foreground">{title}</p>
      ) : null}
      <ul className="divide-y divide-border border border-border bg-card">
        {products.slice(0, limit).map((p) => (
          <li
            key={p.url}
            className="flex items-center justify-between gap-3 p-3 text-sm"
          >
            <ProductCell name={p.name} url={p.url} />
            <span className="flex shrink-0 items-center gap-3">
              <StockBadge available={p.available} />
              <span className="numeric text-right">{formatPrice(p.price)}</span>
            </span>
          </li>
        ))}
        {products.length > limit ? (
          <li className="p-3 text-xs text-muted-foreground">
            {footer ?? `…and ${products.length - limit} more`}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * "What's new since the previous crawl" block: the three diff tiles, the
 * cap caveat, and the list of newly found products. Shared by the Saved
 * crawls row and the Crawler's finished-result panel.
 */
export function CrawlDiffSummary({
  newCount,
  removedCount,
  priceChangedCount,
  products,
  listTitle,
  productsFooter,
}: {
  newCount: number;
  removedCount: number;
  priceChangedCount: number;
  products: DiffProduct[];
  /** Optional heading above the new-products list. */
  listTitle?: string;
  productsFooter?: ReactNode;
}) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <CrawlDiffTile
          tone="success"
          value={`+${newCount}`}
          label="new products"
        />
        <CrawlDiffTile
          tone="destructive"
          value={String(removedCount)}
          label="no longer listed"
        />
        <CrawlDiffTile
          tone="warning"
          value={String(priceChangedCount)}
          label="price changed"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Counts compare this run against the previous snapshot of the same store.
        If a crawl was capped by a page limit, “no longer listed” may include
        products outside the cap.
      </p>
      <NewProductsList
        products={products}
        title={listTitle}
        footer={productsFooter}
      />
    </div>
  );
}
