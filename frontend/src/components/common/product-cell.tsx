/** Product name + optional brand/url link cell, truncated. Used in every
 *  product table/list across the app so the markup stays consistent. */
export function ProductCell({
  name,
  url,
  brand,
}: {
  name: string;
  url?: string;
  brand?: string;
}) {
  return (
    <span className="block min-w-0">
      <span className="block truncate font-medium">{name}</span>
      {brand ? (
        <span className="block truncate text-xs text-muted-foreground">
          {brand}
        </span>
      ) : null}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {url}
        </a>
      ) : null}
    </span>
  );
}
