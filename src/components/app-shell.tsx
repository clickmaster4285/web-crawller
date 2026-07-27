import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  PackageSearch,
  TrendingDown,
  Layers,
  Bell,
  FileText,
  Settings2,
  Sparkles,
  CircleCheck,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { workspace } from "@/lib/demo-data";

const intelligence = [
  { title: "Overview", url: "/", icon: LayoutDashboard },
  { title: "Competitors", url: "/competitors", icon: Users },
  { title: "Matched products", url: "/products", icon: PackageSearch },
  { title: "Price intelligence", url: "/pricing", icon: TrendingDown },
  { title: "Catalogue gaps", url: "/catalogue", icon: Layers },
];

const operations = [
  { title: "AI insights", url: "/insights", icon: Sparkles },
  { title: "Alerts", url: "/alerts", icon: Bell },
  { title: "Reports", url: "/reports", icon: FileText },
  { title: "Sources & crawling", url: "/sources", icon: Settings2 },
];

function AppSidebar() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-accent font-display text-sm text-accent-foreground">
            P
          </span>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate font-display text-base leading-tight">Parity</p>
            <p className="label-caps truncate">Market intelligence</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {intelligence.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Operations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {operations.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3 group-data-[collapsible=icon]:hidden">
        <p className="label-caps">Workspace</p>
        <p className="mt-1 text-sm font-medium">{workspace.name}</p>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <CircleCheck className="size-3 text-success" />
          {workspace.site} verified
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur">
            <SidebarTrigger />
            <span className="label-caps hidden sm:inline">
              {workspace.name} · {workspace.currency} · {workspace.language}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="outline" className="gap-1 border-border font-normal">
                <span className="size-1.5 rounded-full bg-success" />
                Crawling live
              </Badge>
              <span className="hidden text-xs text-muted-foreground md:inline">
                Last scan {workspace.lastScan}
              </span>
            </div>
          </header>
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-6 py-8">
      <div className="max-w-2xl">
        <p className="label-caps">{eyebrow}</p>
        <h1 className="display-xl mt-2">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
