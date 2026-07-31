-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile" ON public.profiles FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- workspaces
CREATE TABLE public.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My workspace',
  site_url TEXT,
  platform TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  language TEXT NOT NULL DEFAULT 'en-GB',
  verified BOOLEAN NOT NULL DEFAULT false,
  verification_method TEXT,
  last_scan_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspaces TO authenticated;
GRANT ALL ON public.workspaces TO service_role;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own workspaces" ON public.workspaces FOR ALL TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE OR REPLACE FUNCTION public.owns_workspace(_workspace_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = _workspace_id AND w.owner_id = auth.uid())
$$;

-- competitors
CREATE TABLE public.competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  name TEXT NOT NULL,
  website TEXT NOT NULL,
  country TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  language TEXT,
  industry TEXT,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  frequency TEXT NOT NULL DEFAULT 'daily',
  last_crawl_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX competitors_workspace_idx ON public.competitors (workspace_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitors TO authenticated;
GRANT ALL ON public.competitors TO service_role;
ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own competitors" ON public.competitors FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- products
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  competitor_id UUID REFERENCES public.competitors ON DELETE CASCADE,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  sku TEXT,
  gtin TEXT,
  url TEXT,
  image_url TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  price NUMERIC(12,2),
  stock TEXT NOT NULL DEFAULT 'unknown',
  match_method TEXT,
  match_confidence INTEGER,
  matched_product_id UUID REFERENCES public.products ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX products_workspace_idx ON public.products (workspace_id);
CREATE INDEX products_competitor_idx ON public.products (competitor_id);
CREATE UNIQUE INDEX products_source_url_idx ON public.products (workspace_id, coalesce(competitor_id::text, 'self'), url) WHERE url IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own products" ON public.products FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- price snapshots
CREATE TABLE public.price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products ON DELETE CASCADE,
  price NUMERIC(12,2),
  stock TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_snapshots_product_idx ON public.price_snapshots (product_id, captured_at DESC);
CREATE INDEX price_snapshots_workspace_idx ON public.price_snapshots (workspace_id, captured_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_snapshots TO authenticated;
GRANT ALL ON public.price_snapshots TO service_role;
ALTER TABLE public.price_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own snapshots" ON public.price_snapshots FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- crawl runs
CREATE TABLE public.crawl_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  competitor_id UUID REFERENCES public.competitors ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',
  trigger TEXT NOT NULL DEFAULT 'manual',
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  products_found INTEGER NOT NULL DEFAULT 0,
  products_changed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX crawl_runs_workspace_idx ON public.crawl_runs (workspace_id, started_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crawl_runs TO authenticated;
GRANT ALL ON public.crawl_runs TO service_role;
ALTER TABLE public.crawl_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own crawl runs" ON public.crawl_runs FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- crawl schedules
CREATE TABLE public.crawl_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  competitor_id UUID NOT NULL UNIQUE REFERENCES public.competitors ON DELETE CASCADE,
  cadence TEXT NOT NULL DEFAULT 'daily',
  max_pages INTEGER NOT NULL DEFAULT 50,
  product_only BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at TIMESTAMPTZ
);
CREATE INDEX crawl_schedules_next_run_idx ON public.crawl_schedules (enabled, next_run_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crawl_schedules TO authenticated;
GRANT ALL ON public.crawl_schedules TO service_role;
ALTER TABLE public.crawl_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own schedules" ON public.crawl_schedules FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- alert rules
CREATE TABLE public.alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  threshold_pct NUMERIC(6,2) NOT NULL DEFAULT 1,
  categories TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, type)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_rules TO authenticated;
GRANT ALL ON public.alert_rules TO service_role;
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own alert rules" ON public.alert_rules FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- alerts
CREATE TABLE public.alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  competitor_id UUID REFERENCES public.competitors ON DELETE CASCADE,
  product_id UUID REFERENCES public.products ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_workspace_idx ON public.alerts (workspace_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO authenticated;
GRANT ALL ON public.alerts TO service_role;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own alerts" ON public.alerts FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- reports
CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces ON DELETE CASCADE,
  name TEXT NOT NULL,
  cadence TEXT NOT NULL DEFAULT 'weekly',
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  categories TEXT[] NOT NULL DEFAULT '{}',
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_workspace_idx ON public.reports (workspace_id, generated_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reports TO authenticated;
GRANT ALL ON public.reports TO service_role;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reports" ON public.reports FOR ALL TO authenticated USING (public.owns_workspace(workspace_id)) WITH CHECK (public.owns_workspace(workspace_id));

-- bootstrap new users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ws_id UUID;
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workspaces (owner_id, name)
  VALUES (NEW.id, 'My workspace')
  RETURNING id INTO ws_id;

  INSERT INTO public.alert_rules (workspace_id, type, threshold_pct)
  VALUES (ws_id, 'price_drop', 1), (ws_id, 'price_rise', 1), (ws_id, 'stock', 0), (ws_id, 'new_product', 0), (ws_id, 'removed', 0);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();