/**
 * Verbose discovery log — the line-by-line trail of what the crawler actually
 * did during discovery (platform detection, each sitemap candidate's outcome,
 * the HTML crawl, and why it ended with the product count it did). Shared by
 * the Crawler results panel and the store catalogue page so the *specific*
 * reason behind a crawl result is visible everywhere, not just a summary.
 */
export function DiscoveryLog({
  lines,
  className,
}: {
  lines: string[];
  className?: string;
}) {
  if (!lines || lines.length === 0) return null;
  return (
    <div className={className}>
      <p className="label-caps mb-2">Discovery log</p>
      <ul className="max-h-40 space-y-1 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        {lines.map((line, i) => (
          <li key={`${line}-${i}`} className="leading-snug">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
