import { CircleCheck, Globe } from "lucide-react";

import { PageHeader } from "@/components/layout/app-shell";
import { SectionTitle } from "@/components/cards/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { workspace } from "@/data/mock";


const detected = [
  ["Platform", workspace.platform],
  ["Currency", workspace.currency],
  ["Language", workspace.language],
  ["Products found", workspace.products.toLocaleString()],
  ["Categories", workspace.categories.toString()],
  ["Product URL pattern", "/products/{slug}"],
  ["Sitemap", "sitemap_index.xml — found"],
  ["robots.txt", "Present, crawl allowed"],
  ["Structured data", "schema.org/Product on 98% of pages"],
];

const discovery = [
  ["XML sitemaps", "1,284 product URLs"],
  ["Category pages", "26 categories traversed"],
  ["Internal links", "4,911 links followed"],
  ["Structured data", "Product + Breadcrumb parsed"],
  ["Product feeds", "Google Merchant feed detected"],
  ["Store APIs", "Shopify products.json available"],
];

export function SourcesPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Configuration"
        title="SourcesPage & crawling"
        description="Your own store is scanned in depth after ownership verification. Competitor stores are crawled politely, respecting robots.txt and rate limits."
        actions={
          <Button>
            <Globe className="size-4" /> Add website
          </Button>
        }
      />

      <div className="grid gap-8 px-6 py-8 lg:grid-cols-2">
        <div>
          <SectionTitle
            aside={
              <Badge variant="secondary" className="gap-1 font-normal">
                <CircleCheck className="size-3 text-success" /> Verified
              </Badge>
            }
          >
            Your website
          </SectionTitle>
          <div className="border border-border bg-card p-5">
            <p className="font-display text-2xl">{workspace.site}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Ownership confirmed via {workspace.verificationMethod} · last scan {workspace.lastScan}
            </p>
            <dl className="mt-5 space-y-2 text-sm">
              {detected.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-border pb-2 last:border-0">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <SectionTitle>Discovery engine</SectionTitle>
          <ul className="divide-y divide-border border border-border bg-card">
            {discovery.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-4 p-3.5 text-sm">
                <span>{k}</span>
                <span className="text-xs text-muted-foreground">{v}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <SectionTitle>Crawl configuration</SectionTitle>
          <div className="space-y-6 border border-border bg-card p-5">
            <div className="grid gap-2">
              <Label>Frequency</Label>
              <Select defaultValue="6h">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">Every hour</SelectItem>
                  <SelectItem value="6h">Every 6 hours</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label>Maximum pages per crawl</Label>
              <Select defaultValue="5000">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="500">500</SelectItem>
                  <SelectItem value="1000">1,000</SelectItem>
                  <SelectItem value="5000">5,000</SelectItem>
                  <SelectItem value="unlimited">Unlimited</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="product-only">Product-only mode</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Skip blog, help and policy pages</p>
              </div>
              <Switch id="product-only" defaultChecked />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="robots">Respect robots.txt</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Recommended for all sources</p>
              </div>
              <Switch id="robots" defaultChecked />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="snapshot">Store full snapshots</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Keeps history for trend analysis</p>
              </div>
              <Switch id="snapshot" defaultChecked />
            </div>
          </div>

          <SectionTitle>Verify a new website</SectionTitle>
          <div className="space-y-4 border border-border bg-card p-5">
            <div className="grid gap-2">
              <Label htmlFor="url">Website URL</Label>
              <Input id="url" placeholder="https://mystore.com" />
            </div>
            <div className="rule-top space-y-3 pt-4 text-sm">
              <p className="label-caps">Verification methods</p>
              <p className="text-muted-foreground">
                Upload <span className="numeric">parity-verify.html</span> to your web root, add a
                <span className="numeric"> &lt;meta name="parity-verify"&gt;</span> tag, or publish a DNS TXT
                record.
              </p>
            </div>
            <Button variant="outline" className="w-full">
              Verify ownership
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
