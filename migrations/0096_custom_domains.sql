-- Platform-admin-managed custom domains, each serving exactly one of four core
-- services with its own branding, while accounts/wallet/orders stay shared with
-- the main site. See docs/superpowers/specs/2026-09-11-custom-domain-service-routing-design.md.

create table if not exists custom_domains (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,
  service text not null check (service in ('data_bundles','airtime','results_checker','bulk_sms')),
  site_name text not null,
  logo_url text,
  primary_color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table custom_domains enable row level security;

-- Public, unauthenticated read of active domains only — this is exactly what a
-- public website renders, and it's a defense-in-depth backstop (the app itself
-- reads this table via the service-role client, which bypasses RLS entirely).
-- Scoped deliberately, not a blanket USING(true) grant, per this project's RLS
-- incident history (see [[project-rls-grant-model]] in project memory).
create policy "custom_domains_public_read" on custom_domains
  for select to anon, authenticated
  using (is_active = true);

-- No insert/update/delete policy: writes only ever go through the service-role
-- admin API route (app/api/admin/custom-domains/route.ts), which bypasses RLS.
