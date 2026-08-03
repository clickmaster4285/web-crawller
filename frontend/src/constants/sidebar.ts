import {
  Archive,
  Bell,
  FileText,
  Layers,
  LayoutDashboard,
  PackageSearch,
  Settings2,
  Sparkles,
  TrendingDown,
  Users,
  type LucideIcon,
} from "lucide-react";

import { ROUTES } from "./routes";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
}

export const INTELLIGENCE_NAV: NavItem[] = [
  { title: "Overview", url: ROUTES.overview, icon: LayoutDashboard },
  { title: "Competitors", url: ROUTES.competitors, icon: Users },
  { title: "Matched products", url: ROUTES.products, icon: PackageSearch },
  { title: "Price intelligence", url: ROUTES.pricing, icon: TrendingDown },
  { title: "Catalogue gaps", url: ROUTES.catalogue, icon: Layers },
];

export const OPERATIONS_NAV: NavItem[] = [
  { title: "Crawler", url: ROUTES.sources, icon: Settings2 },
  { title: "Saved crawls", url: ROUTES.crawls, icon: Archive },
  { title: "AI insights", url: ROUTES.insights, icon: Sparkles },
  { title: "Alerts", url: ROUTES.alerts, icon: Bell },
  { title: "Reports", url: ROUTES.reports, icon: FileText },
];
