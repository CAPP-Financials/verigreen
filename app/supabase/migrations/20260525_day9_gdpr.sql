-- Day 9: GDPR compliance + model_call_log table
-- Applies:
--   1. organizations.deleted_at — soft delete for GDPR tombstoning
--   2. model_call_log table     — Adversarial Layer 8 immutable audit trail

-- ── 1. Soft-delete support on organizations ───────────────────────────────────

alter table public.organizations
  add column if not exists deleted_at timestamptz;

comment on column public.organizations.deleted_at is
  'Set on GDPR deletion. Org data purged; row retained for audit trail.';

create index if not exists organizations_deleted_at_idx
  on public.organizations (deleted_at)
  where deleted_at is not null;

-- Exclude soft-deleted orgs from is_org_member checks
-- (existing function already gates on org_id; deleted_at is advisory for UI filtering)

-- ── 2. model_call_log — per-call LLM audit trail (Adversarial Layer 8) ────────

create table if not exists public.model_call_log (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  document_id      uuid references public.documents (id) on delete set null,
  model_id         text not null,
  system_prompt_hash text not null,   -- sha256 hex of system prompt
  user_message_hash  text not null,   -- sha256 hex of wrapped user message
  output_hash        text not null,   -- sha256 hex of raw LLM output
  tokens_in        integer not null default 0,
  tokens_out       integer not null default 0,
  duration_ms      integer not null default 0,
  created_at       timestamptz not null default now()
);

comment on table public.model_call_log is
  'Immutable per-call LLM audit trail. Hashes enable replay detection. '
  'Layer 8 of VeriGreen adversarial robustness architecture.';

-- Append-only: members can read their org''s logs; only service role can insert
alter table public.model_call_log enable row level security;

create policy "org members can read model_call_log"
  on public.model_call_log for select
  using (is_org_member(auth.uid(), org_id));

-- No INSERT policy for authenticated users — only supabaseAdmin (service role) inserts.
-- This enforces append-only from untrusted clients.

-- Indexes for audit queries
create index if not exists model_call_log_org_id_idx
  on public.model_call_log (org_id, created_at desc);

create index if not exists model_call_log_document_id_idx
  on public.model_call_log (document_id)
  where document_id is not null;

-- Retention: rows older than 90 days can be pruned by a scheduled pg_cron job.
-- Default retention = unlimited (configurable post-launch per enterprise tenant).
