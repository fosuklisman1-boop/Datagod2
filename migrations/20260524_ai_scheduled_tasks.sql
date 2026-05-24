-- =============================================
-- AI Scheduled Tasks
-- Stores recurring/one-time tasks that the AI cron engine executes automatically.
-- =============================================

create table if not exists public.ai_scheduled_tasks (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  prompt           text not null,
  context          text not null check (context in ('admin', 'dashboard')),
  user_id          uuid references auth.users(id) on delete cascade,
  user_role        text not null default 'user',
  schedule_type    text not null check (schedule_type in ('once', 'hourly', 'daily', 'weekly')),
  run_at_time      text,           -- "HH:MM" UTC — required for daily/weekly
  run_on_days      int[],          -- 0=Sun … 6=Sat — required for weekly
  run_at_timestamp timestamptz,    -- exact datetime — required for once
  notify_channels  text[] not null default '{push}',  -- push | sms | email
  next_run_at      timestamptz not null,
  last_run_at      timestamptz,
  last_result      text,
  last_success     boolean,
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);

-- Index for efficient cron polling
create index if not exists ai_scheduled_tasks_next_run_idx
  on public.ai_scheduled_tasks (next_run_at)
  where is_active = true;

-- RLS
alter table public.ai_scheduled_tasks enable row level security;

create policy "Admins manage all scheduled tasks"
  on public.ai_scheduled_tasks for all
  using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );

-- SELECT / UPDATE / DELETE: users can only touch their own rows
create policy "Users read and delete own scheduled tasks"
  on public.ai_scheduled_tasks for select
  using (user_id = auth.uid());

create policy "Users delete own scheduled tasks"
  on public.ai_scheduled_tasks for delete
  using (user_id = auth.uid());

create policy "Users update own scheduled tasks"
  on public.ai_scheduled_tasks for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and context = 'dashboard'
    and user_role not in ('admin')
  );

-- INSERT: enforce context=dashboard and non-admin role at the DB layer
-- This prevents a user calling Supabase directly from escalating to admin context
create policy "Users insert own dashboard tasks only"
  on public.ai_scheduled_tasks for insert
  with check (
    user_id = auth.uid()
    and context = 'dashboard'
    and user_role not in ('admin')
  );
