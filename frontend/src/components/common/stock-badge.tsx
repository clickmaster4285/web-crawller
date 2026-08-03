import { Badge } from "@/components/ui/badge";

/** In-stock / out-of-stock pill used in every product list across the app. */
export function StockBadge({ available }: { available: boolean }) {
  return (
    <Badge
      variant={available ? "secondary" : "destructive"}
      className="font-normal"
    >
      {available ? "In stock" : "Out of stock"}
    </Badge>
  );
}
