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

create policy "Service role full access on ai_knowledge"
  on ai_knowledge for all
  using (true) with check (true);
