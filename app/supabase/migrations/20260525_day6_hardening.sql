-- Day-6 hardening migration
-- Adds: rate limiting, outbound webhook infrastructure, API key rate-limit config

-- =========================================================
-- 1. API key rate-limit configuration
-- =========================================================
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute int NOT NULL DEFAULT 60;

-- =========================================================
-- 2. Rate-limit counters (sliding 1-minute window)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  api_key_id  uuid         NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count int         NOT NULL DEFAULT 1,
  PRIMARY KEY (api_key_id, window_start)
);

-- Prune old windows via a periodic job or DELETE WHERE window_start < now() - interval '2 minutes'
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx
  ON public.rate_limit_counters (window_start);

-- =========================================================
-- 3. Outbound webhook endpoints (Worker → customer)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  url            text    NOT NULL,
  -- plaintext signing secret for outbound HMAC; protected by Supabase at-rest encryption + admin RLS
  signing_secret text    NOT NULL,
  events         text[]  NOT NULL DEFAULT ARRAY['extraction.completed', 'extraction.failed'],
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_org_active_idx
  ON public.webhook_endpoints (org_id) WHERE enabled = true;

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins manage webhook endpoints" ON public.webhook_endpoints
  FOR ALL TO authenticated
  USING  (public.has_role(auth.uid(), org_id, 'admin'))
  WITH CHECK (public.has_role(auth.uid(), org_id, 'admin'));

-- =========================================================
-- 4. Outbound delivery log / dead-letter queue
-- =========================================================
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      uuid    NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  org_id           uuid    NOT NULL REFERENCES public.organizations(id)    ON DELETE CASCADE,
  event_type       text    NOT NULL,
  payload          jsonb   NOT NULL,
  attempt_count    int     NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  last_status_code int,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_org_created_idx
  ON public.webhook_deliveries (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
  ON public.webhook_deliveries (endpoint_id, delivered_at);
-- Pending DLQ entries (failed, not yet delivered)
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON public.webhook_deliveries (created_at) WHERE delivered_at IS NULL;

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read deliveries" ON public.webhook_deliveries
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), org_id, 'admin'));

-- =========================================================
-- 5. Pre-populate taxonomy_nodes with GRI 302/303/305/306 + SASB cross-industry
--    Allows extraction-callback handler to FK-link validations without upsert races.
-- =========================================================
INSERT INTO public.taxonomy_nodes (framework, code, name, version) VALUES
  ('gri', '302-1', 'Energy consumption within the organization',           'v1'),
  ('gri', '302-2', 'Energy consumption outside of the organization',       'v1'),
  ('gri', '302-3', 'Energy intensity',                                      'v1'),
  ('gri', '302-4', 'Reduction of energy consumption',                       'v1'),
  ('gri', '302-5', 'Reductions in energy requirements of products',         'v1'),
  ('gri', '303-1', 'Interactions with water as a shared resource',          'v1'),
  ('gri', '303-2', 'Management of water discharge-related impacts',         'v1'),
  ('gri', '303-3', 'Water withdrawal',                                       'v1'),
  ('gri', '303-4', 'Water discharge',                                        'v1'),
  ('gri', '303-5', 'Water consumption',                                      'v1'),
  ('gri', '305-1', 'Direct (Scope 1) GHG emissions',                        'v1'),
  ('gri', '305-2', 'Energy indirect (Scope 2) GHG emissions',               'v1'),
  ('gri', '305-3', 'Other indirect (Scope 3) GHG emissions',                'v1'),
  ('gri', '305-4', 'GHG emissions intensity',                                'v1'),
  ('gri', '305-5', 'Reduction of GHG emissions',                            'v1'),
  ('gri', '305-6', 'Emissions of ozone-depleting substances',               'v1'),
  ('gri', '305-7', 'Nitrogen oxides, sulfur oxides, and other significant air emissions', 'v1'),
  ('gri', '306-1', 'Waste generation and significant waste-related impacts', 'v1'),
  ('gri', '306-2', 'Management of significant waste-related impacts',        'v1'),
  ('gri', '306-3', 'Waste generated',                                        'v1'),
  ('gri', '306-4', 'Waste diverted from disposal',                           'v1'),
  ('gri', '306-5', 'Waste directed to disposal',                             'v1'),
  ('sasb', 'EM-GHG-1', 'Gross global Scope 1 GHG emissions',               'v1'),
  ('sasb', 'EM-GHG-2', 'Scope 2 GHG emissions',                            'v1'),
  ('sasb', 'EN-USE',   'Total energy consumed',                             'v1'),
  ('sasb', 'EN-REN',   'Percentage of energy from renewable sources',       'v1'),
  ('sasb', 'WT-USE',   'Total water withdrawn',                             'v1'),
  ('sasb', 'WT-STR',   'Water withdrawn in high water stress areas',        'v1'),
  ('sasb', 'WST-HAZ',  'Amount of hazardous waste generated',               'v1'),
  ('sasb', 'AIR-1',    'Air quality emissions (NOx, SOx, particulates)',    'v1')
ON CONFLICT (framework, code, version) DO NOTHING;

-- =========================================================
-- 6. Atomic rate-limit increment RPC
--    Returns the new request_count for (key, window).
-- =========================================================
CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_api_key_id  uuid,
  p_window_start timestamptz
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO public.rate_limit_counters (api_key_id, window_start, request_count)
  VALUES (p_api_key_id, p_window_start, 1)
  ON CONFLICT (api_key_id, window_start)
  DO UPDATE SET request_count = rate_limit_counters.request_count + 1
  RETURNING request_count INTO v_count;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_rate_limit(uuid, timestamptz) FROM PUBLIC, anon;
-- Only service_role (supabaseAdmin) may call this function
