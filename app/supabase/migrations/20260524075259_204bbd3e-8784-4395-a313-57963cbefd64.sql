
-- =========================================================
-- ENUMS
-- =========================================================
create type public.app_role as enum ('admin', 'analyst', 'viewer');
create type public.document_status as enum (
  'uploaded','parsing','parsed','extracting','validating','complete','failed','cancelled'
);
create type public.extraction_job_status as enum (
  'pending','dispatched','running','complete','failed','cancelled'
);
create type public.framework as enum ('gri','sasb');

-- =========================================================
-- TABLES
-- =========================================================
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.organization_members (user_id);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, org_id, role)
);
create index on public.user_roles (org_id);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.api_keys (org_id);

create table public.webhook_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  secret_hash text not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.webhook_secrets (org_id) where revoked_at is null;

create table public.extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  status public.extraction_job_status not null default 'pending',
  dispatched_at timestamptz,
  completed_at timestamptz,
  ml_service_response_id text,
  retry_count int not null default 0,
  error_message text,
  created_at timestamptz not null default now()
);
create index on public.extraction_jobs (org_id);
create index on public.extraction_jobs (document_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  byte_size bigint not null default 0,
  page_count int,
  status public.document_status not null default 'uploaded',
  status_updated_at timestamptz not null default now(),
  failure_reason text,
  extraction_job_id uuid references public.extraction_jobs(id) on delete set null,
  taxonomy_version text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.documents (org_id);
alter table public.extraction_jobs
  add constraint extraction_jobs_document_fk
  foreign key (document_id) references public.documents(id) on delete cascade;

create table public.taxonomy_nodes (
  id uuid primary key default gen_random_uuid(),
  framework public.framework not null,
  code text not null,
  name text not null,
  description text,
  parent_id uuid references public.taxonomy_nodes(id) on delete set null,
  version text not null,
  created_at timestamptz not null default now(),
  unique (framework, code, version)
);

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  page_num int not null,
  char_start int not null,
  char_end int not null,
  raw_text text not null,
  normalized_value numeric,
  unit text,
  category text,
  created_at timestamptz not null default now()
);
create index on public.claims (document_id);
create index on public.claims (org_id);

create table public.validations (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  taxonomy_node_id uuid references public.taxonomy_nodes(id) on delete set null,
  taxonomy_version text,
  model_id text,
  confidence numeric,
  status text,
  substantiation_score numeric,
  substantiation_indicators jsonb,
  created_at timestamptz not null default now()
);
create index on public.validations (claim_id);
create index on public.validations (org_id);

create table public.human_corrections (
  id uuid primary key default gen_random_uuid(),
  validation_id uuid not null references public.validations(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete set null,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index on public.human_corrections (validation_id);
create index on public.human_corrections (org_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_logs (org_id);

-- =========================================================
-- SECURITY DEFINER HELPERS (avoid RLS recursion)
-- =========================================================
create or replace function public.is_org_member(_user_id uuid, _org_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where user_id = _user_id and org_id = _org_id
  );
$$;

create or replace function public.has_role(_user_id uuid, _org_id uuid, _role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and org_id = _org_id and role = _role
  );
$$;

create or replace function public.has_any_role(_user_id uuid, _org_id uuid, _roles public.app_role[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and org_id = _org_id and role = any(_roles)
  );
$$;

-- =========================================================
-- ENABLE RLS
-- =========================================================
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.user_roles enable row level security;
alter table public.api_keys enable row level security;
alter table public.webhook_secrets enable row level security;
alter table public.documents enable row level security;
alter table public.extraction_jobs enable row level security;
alter table public.taxonomy_nodes enable row level security;
alter table public.claims enable row level security;
alter table public.validations enable row level security;
alter table public.human_corrections enable row level security;
alter table public.audit_logs enable row level security;

-- organizations: members can read; admins can update name
create policy "org members read org" on public.organizations
  for select to authenticated
  using (public.is_org_member(auth.uid(), id));
create policy "admins update org" on public.organizations
  for update to authenticated
  using (public.has_role(auth.uid(), id, 'admin'))
  with check (public.has_role(auth.uid(), id, 'admin'));

-- organization_members: members can read membership for their orgs
create policy "members read membership" on public.organization_members
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));
create policy "admins manage membership" on public.organization_members
  for all to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'))
  with check (public.has_role(auth.uid(), org_id, 'admin'));

-- user_roles: members can read roles in their orgs; admins manage
create policy "members read roles" on public.user_roles
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));
create policy "admins manage roles" on public.user_roles
  for all to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'))
  with check (public.has_role(auth.uid(), org_id, 'admin'));

-- api_keys: admins only
create policy "admins read api keys" on public.api_keys
  for select to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'));
create policy "admins write api keys" on public.api_keys
  for all to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'))
  with check (public.has_role(auth.uid(), org_id, 'admin'));

-- webhook_secrets: admins only
create policy "admins read webhook secrets" on public.webhook_secrets
  for select to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'));
create policy "admins write webhook secrets" on public.webhook_secrets
  for all to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'))
  with check (public.has_role(auth.uid(), org_id, 'admin'));

-- documents
create policy "members read documents" on public.documents
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));
create policy "writers insert documents" on public.documents
  for insert to authenticated
  with check (public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[]));
create policy "writers update documents" on public.documents
  for update to authenticated
  using (public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[]))
  with check (public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[]));
create policy "admins delete documents" on public.documents
  for delete to authenticated
  using (public.has_role(auth.uid(), org_id, 'admin'));

-- extraction_jobs
create policy "members read jobs" on public.extraction_jobs
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));
create policy "writers insert jobs" on public.extraction_jobs
  for insert to authenticated
  with check (public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[]));
create policy "writers update jobs" on public.extraction_jobs
  for update to authenticated
  using (public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[]))
  with check (public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[]));

-- taxonomy_nodes: readable by any authenticated user (shared reference data)
create policy "authenticated read taxonomy" on public.taxonomy_nodes
  for select to authenticated using (true);

-- claims
create policy "members read claims" on public.claims
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));

-- validations
create policy "members read validations" on public.validations
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));

-- human_corrections
create policy "members read corrections" on public.human_corrections
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));
create policy "writers insert corrections" on public.human_corrections
  for insert to authenticated
  with check (
    public.has_any_role(auth.uid(), org_id, array['admin','analyst']::public.app_role[])
    and user_id = auth.uid()
  );

-- audit_logs: insert + select-own-org only (no update/delete)
create policy "members read audit" on public.audit_logs
  for select to authenticated
  using (public.is_org_member(auth.uid(), org_id));
create policy "members insert audit" on public.audit_logs
  for insert to authenticated
  with check (public.is_org_member(auth.uid(), org_id));

-- =========================================================
-- TRIGGERS
-- =========================================================
create or replace function public.touch_document_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    new.status_updated_at := now();
    insert into public.audit_logs (org_id, actor_user_id, action, target_type, target_id, payload)
    values (new.org_id, auth.uid(), 'document_status_changed', 'document', new.id::text,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end$$;
create trigger documents_status_touch
  before update on public.documents
  for each row execute function public.touch_document_status();

-- On signup: create personal org + admin role
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_org_id uuid;
  base_slug text;
  final_slug text;
  suffix int := 0;
begin
  base_slug := regexp_replace(lower(coalesce(split_part(new.email,'@',1), 'user')), '[^a-z0-9]+','-','g');
  if base_slug = '' or base_slug is null then base_slug := 'org'; end if;
  final_slug := base_slug;
  while exists (select 1 from public.organizations where slug = final_slug) loop
    suffix := suffix + 1;
    final_slug := base_slug || '-' || suffix::text;
  end loop;

  insert into public.organizations (name, slug)
  values (coalesce(new.raw_user_meta_data->>'org_name', initcap(replace(base_slug,'-',' ')) || ' Workspace'), final_slug)
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id) values (new_org_id, new.id);
  insert into public.user_roles (user_id, org_id, role) values (new.id, new_org_id, 'admin');

  insert into public.audit_logs (org_id, actor_user_id, action, target_type, target_id)
  values (new_org_id, new.id, 'org_created', 'organization', new_org_id::text);
  return new;
end$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- STORAGE BUCKET + POLICIES
-- =========================================================
insert into storage.buckets (id, name, public) values ('documents','documents', false)
  on conflict (id) do nothing;

create policy "members read doc objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

create policy "writers insert doc objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.has_any_role(auth.uid(), ((storage.foldername(name))[1])::uuid, array['admin','analyst']::public.app_role[])
  );

create policy "writers update doc objects" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and public.has_any_role(auth.uid(), ((storage.foldername(name))[1])::uuid, array['admin','analyst']::public.app_role[])
  );

create policy "admins delete doc objects" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.has_role(auth.uid(), ((storage.foldername(name))[1])::uuid, 'admin')
  );
