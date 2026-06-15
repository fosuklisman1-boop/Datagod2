-- Creates the AI knowledge base table.
--
-- The original migrations/create_ai_knowledge_table.sql was never applied to
-- prod, so /admin/ai-knowledge errored on load and the bot's get_knowledge_base
-- tool returned a "relation ai_knowledge does not exist" error on every call —
-- the assistants had no knowledge base at all.
--
-- Security: every read/write goes through a SERVICE-ROLE client (the
-- get_knowledge_base tool and the /api/admin/ai-knowledge routes both use
-- supabaseAdmin), which bypasses RLS. So we enable RLS with NO anon/authenticated
-- policy (default-deny) and REVOKE the blanket grants from migration 0060. The
-- original `for all using(true) with check(true)` policy would have let any
-- logged-in customer read/write/delete KB entries via the REST API.

create table if not exists ai_knowledge (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'faq',
  question text not null,
  answer text not null,
  contexts text[] not null default array['storefront', 'dashboard', 'admin'],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ai_knowledge enable row level security;

-- Remove the over-permissive policy if a prior run of the old migration created it.
drop policy if exists "Service role full access on ai_knowledge" on ai_knowledge;

-- Lock direct (anon/authenticated) access; only service-role server code touches this.
revoke all on table ai_knowledge from anon, authenticated;
