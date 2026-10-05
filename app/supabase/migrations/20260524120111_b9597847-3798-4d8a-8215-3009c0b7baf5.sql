-- 1. validations
ALTER TABLE public.validations
  ADD COLUMN IF NOT EXISTS adversarial_indicators jsonb,
  ADD COLUMN IF NOT EXISTS substantiation_indicators jsonb;

-- 2. claims
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS normalized_value_uncertain boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_value numeric,
  ADD COLUMN IF NOT EXISTS max_value numeric;

-- 3. extraction_jobs
ALTER TABLE public.extraction_jobs
  ADD COLUMN IF NOT EXISTS tokens_in int,
  ADD COLUMN IF NOT EXISTS tokens_out int,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(10,4);

-- 4. model_call_log
CREATE TABLE IF NOT EXISTS public.model_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  model_id text NOT NULL,
  system_prompt_hash text NOT NULL,
  user_message_hash text NOT NULL,
  output_hash text NOT NULL,
  tokens_in int,
  tokens_out int,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_call_log_org_created_idx
  ON public.model_call_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_call_log_document_idx
  ON public.model_call_log (document_id);

ALTER TABLE public.model_call_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read model calls" ON public.model_call_log;
CREATE POLICY "members read model calls" ON public.model_call_log
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), org_id));

-- 5. Tighten audit_logs: remove direct user insert path
DROP POLICY IF EXISTS "members insert audit" ON public.audit_logs;