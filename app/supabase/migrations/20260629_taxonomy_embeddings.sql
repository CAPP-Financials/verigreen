CREATE TABLE IF NOT EXISTS public.taxonomy_embeddings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id      text        NOT NULL,
  embedding    jsonb       NOT NULL,        -- 768-float array
  source       text        NOT NULL DEFAULT 'gemini-text-embedding-004',
  anchor_type  text        NOT NULL DEFAULT 'canonical',  -- 'canonical'|'feedback'
  org_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  anchor_count int         NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_updated timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS taxonomy_embeddings_node_idx
  ON public.taxonomy_embeddings (node_id);
CREATE INDEX IF NOT EXISTS taxonomy_embeddings_canonical_idx
  ON public.taxonomy_embeddings (node_id) WHERE anchor_type = 'canonical';

ALTER TABLE public.taxonomy_embeddings ENABLE ROW LEVEL SECURITY;
-- No policy = no authenticated access; service_role bypasses RLS

-- validations: add embedding + Gemini validation metadata
ALTER TABLE public.validations
  ADD COLUMN IF NOT EXISTS embedding                jsonb,
  ADD COLUMN IF NOT EXISTS gemini_validation_model  text DEFAULT 'gemini-2.0-flash',
  ADD COLUMN IF NOT EXISTS gemini_valid             boolean,
  ADD COLUMN IF NOT EXISTS gemini_confidence        numeric(4,3),
  ADD COLUMN IF NOT EXISTS gemini_rejection_reason  text;

CREATE INDEX IF NOT EXISTS validations_embedding_idx
  ON public.validations (id) WHERE embedding IS NOT NULL;

-- extraction_jobs: track Make.com run ID + dispatch destination
ALTER TABLE public.extraction_jobs
  ADD COLUMN IF NOT EXISTS make_scenario_run_id text,
  ADD COLUMN IF NOT EXISTS dispatched_to        text DEFAULT 'make_com',
  ADD COLUMN IF NOT EXISTS dispatch_payload     jsonb;
