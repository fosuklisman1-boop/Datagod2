-- 0163_text_to_buy.sql
--
-- Text-to-Buy, Stage 1: a customer texts an order to Datagod's number and gets a MoMo prompt. This file holds the TABLES,
-- the SQL FUNCTIONS and the default SETTINGS. Nothing reads these until the later tasks of the plan.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. One transaction. Idempotent (re-runnable).
-- Ships dark: ttb_main_enabled is false.
--
--   ttb_messages       every inbound text and every outbound reply (line 'main' or 'shop'). Inbound rows carry a dedupe_key
--                      so a forwarder retry is stored once. Purged after ttb_retention_days by ttb_purge.
--   ttb_conversations  short rolling context per (line, sender): last turns, a pending question and the last order.
--   ttb_orders         the link between a text and the order it placed. order_table + order_id point at the order row;
--                      order_id is NOT a foreign key (later stages add other order tables). state: awaiting_payment -> paid
--                      -> closed. paid_at / delivered_at are set once, when that happens, and survive closing: state alone
--                      cannot tell "paid, then closed" from "closed unpaid", and ttb_overview needs the difference.
--                      notices records which follow-ups were sent: 'unpaid', 'delivered', 'paid_not_delivered'.
--                      One open (awaiting_payment) order per (line, sender): the unique partial index is the final guard.
--   ttb_blocked        senders refused by an admin.
--   ttb_heartbeat      last time each line's forwarder was seen (for the quiet-line alert).
--
-- All five: RLS on, no policies. 0060 grants authenticated CRUD by default, so the REVOKE is what keeps it out; it also takes
-- service_role's default ALL back. Nobody gets TRUNCATE. service_role:
--   ttb_messages SELECT, INSERT, UPDATE (rows are removed only by ttb_purge)   ttb_orders SELECT, INSERT, UPDATE (never deleted)
--   ttb_conversations, ttb_heartbeat SELECT, INSERT, UPDATE                    ttb_blocked SELECT, INSERT, UPDATE, DELETE
--
-- Functions (SECURITY DEFINER, search_path = public, pg_temp, EXECUTE for service_role only), every table name schema-qualified:
--   ttb_counts(p_line, p_sender, p_since)  rows since p_since for one line and sender:
--       prompts_unpaid  orders created since p_since that are awaiting_payment or have 'unpaid' in notices
--       replies         outbound messages
--       ai_reads        inbound messages with read_by = 'ai'
--       not_understood  inbound messages with outcome = 'not_order'
--   ttb_global_prompts(p_since)            orders created since p_since, all lines and senders (the global prompt cap)
--   ttb_overview(p_from)                   one row per line ('main', 'shop', always both), all counted since p_from:
--       texts       inbound messages
--       prompts     orders created (a MoMo prompt was requested)
--       paid        of those orders, the ones with paid_at set
--       delivered   of those orders, the ones with delivered_at set
--       replies     outbound messages
--       ai_reads    inbound messages with read_by = 'ai'
--       rule_reads  inbound messages with read_by = 'rules'
--   ttb_purge(p_before)                    deletes ttb_messages created before p_before and ttb_conversations that expired
--                                          before p_before; returns the number of rows deleted. Never touches ttb_orders.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.ttb_messages'), to_regclass('public.ttb_conversations'), to_regclass('public.ttb_orders'),
--          to_regclass('public.ttb_blocked'), to_regclass('public.ttb_heartbeat');                  -- all NULL
--   SELECT count(*) FROM pg_proc WHERE proname LIKE 'ttb\_%';                                        -- 0
--   SELECT count(*) FROM admin_settings WHERE key LIKE 'ttb\_%';                                     -- 0
--   SELECT data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'admin_settings' AND column_name = 'value';     -- jsonb
--
-- Self-test (self-rolling-back dry run): migrations/0163_text_to_buy.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/text-to-buy/migration-0163.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Messages.
CREATE TABLE IF NOT EXISTS public.ttb_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line          text NOT NULL CHECK (line IN ('main', 'shop')),
  sender        text NOT NULL,                                   -- local 0XXXXXXXXX
  direction     text NOT NULL CHECK (direction IN ('in', 'out')),
  body          text NOT NULL,
  received_at   timestamptz,                                     -- the forwarder's receive time; inbound only
  dedupe_key    text UNIQUE,                                     -- inbound only
  read_by       text CHECK (read_by IN ('rules', 'ai')),
  outcome       text,
  order_link_id uuid,
  misread       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ttb_messages_line_sender_created_idx ON public.ttb_messages (line, sender, created_at DESC);
CREATE INDEX IF NOT EXISTS ttb_messages_created_idx             ON public.ttb_messages (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ttb_messages_outcome_created_idx     ON public.ttb_messages (outcome, created_at DESC);

-- 2. Conversations.
CREATE TABLE IF NOT EXISTS public.ttb_conversations (
  line        text NOT NULL CHECK (line IN ('main', 'shop')),
  sender      text NOT NULL,
  turns       jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending     jsonb,
  last_order  jsonb,
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line, sender)
);

-- 3. Orders placed by text.
CREATE TABLE IF NOT EXISTS public.ttb_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line         text NOT NULL CHECK (line IN ('main', 'shop')),
  sender       text NOT NULL,
  service      text NOT NULL DEFAULT 'data',
  order_table  text NOT NULL DEFAULT 'ussd_orders',
  order_id     uuid NOT NULL UNIQUE,                             -- not a foreign key: order_table says which table
  state        text NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment', 'paid', 'closed')),
  size         text NOT NULL,
  recipient    text NOT NULL,
  gift         boolean NOT NULL,
  amount       numeric NOT NULL,
  notices      text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  delivered_at timestamptz,
  closed_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ttb_orders_one_open ON public.ttb_orders (line, sender) WHERE state = 'awaiting_payment';
CREATE INDEX IF NOT EXISTS ttb_orders_line_sender_created_idx ON public.ttb_orders (line, sender, created_at DESC);
CREATE INDEX IF NOT EXISTS ttb_orders_created_idx             ON public.ttb_orders (created_at DESC);

-- 4. Blocked senders.
CREATE TABLE IF NOT EXISTS public.ttb_blocked (
  sender     text PRIMARY KEY,
  reason     text,
  blocked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Forwarder heartbeat. Besides the two lines it holds the bookkeeping rows 'purge' and 'quiet_alert' (when the retention
--    purge last ran and when the quiet-line alert last fired), which is why the check lists more than 'main' and 'shop'.
CREATE TABLE IF NOT EXISTS public.ttb_heartbeat (
  line         text PRIMARY KEY CHECK (line IN ('main', 'shop', 'purge', 'quiet_alert')),
  last_seen_at timestamptz NOT NULL
);

-- 6. Lock the tables down. No policies on purpose.
ALTER TABLE public.ttb_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttb_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttb_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttb_blocked       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttb_heartbeat     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ttb_messages      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ttb_conversations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ttb_orders        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ttb_blocked       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ttb_heartbeat     FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE         ON TABLE public.ttb_messages      TO service_role;
GRANT SELECT, INSERT, UPDATE         ON TABLE public.ttb_conversations TO service_role;
GRANT SELECT, INSERT, UPDATE         ON TABLE public.ttb_orders        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ttb_blocked       TO service_role;
GRANT SELECT, INSERT, UPDATE         ON TABLE public.ttb_heartbeat     TO service_role;

-- 7. Functions.
CREATE OR REPLACE FUNCTION public.ttb_counts(p_line text, p_sender text, p_since timestamptz)
RETURNS TABLE(prompts_unpaid int, replies int, ai_reads int, not_understood int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT
    (SELECT count(*)::int FROM public.ttb_orders o
      WHERE o.line = p_line AND o.sender = p_sender AND o.created_at >= p_since
        AND (o.state = 'awaiting_payment' OR 'unpaid' = ANY (o.notices))),
    (SELECT count(*)::int FROM public.ttb_messages m
      WHERE m.line = p_line AND m.sender = p_sender AND m.created_at >= p_since AND m.direction = 'out'),
    (SELECT count(*)::int FROM public.ttb_messages m
      WHERE m.line = p_line AND m.sender = p_sender AND m.created_at >= p_since AND m.direction = 'in' AND m.read_by = 'ai'),
    (SELECT count(*)::int FROM public.ttb_messages m
      WHERE m.line = p_line AND m.sender = p_sender AND m.created_at >= p_since AND m.direction = 'in' AND m.outcome = 'not_order')
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_global_prompts(p_since timestamptz)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int FROM public.ttb_orders o WHERE o.created_at >= p_since
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_overview(p_from timestamptz)
RETURNS TABLE(line text, texts int, prompts int, paid int, delivered int, replies int, ai_reads int, rule_reads int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT l.line,
    (SELECT count(*)::int FROM public.ttb_messages m WHERE m.line = l.line AND m.created_at >= p_from AND m.direction = 'in'),
    (SELECT count(*)::int FROM public.ttb_orders o WHERE o.line = l.line AND o.created_at >= p_from),
    (SELECT count(*)::int FROM public.ttb_orders o WHERE o.line = l.line AND o.created_at >= p_from AND o.paid_at IS NOT NULL),
    (SELECT count(*)::int FROM public.ttb_orders o WHERE o.line = l.line AND o.created_at >= p_from AND o.delivered_at IS NOT NULL),
    (SELECT count(*)::int FROM public.ttb_messages m WHERE m.line = l.line AND m.created_at >= p_from AND m.direction = 'out'),
    (SELECT count(*)::int FROM public.ttb_messages m WHERE m.line = l.line AND m.created_at >= p_from AND m.direction = 'in' AND m.read_by = 'ai'),
    (SELECT count(*)::int FROM public.ttb_messages m WHERE m.line = l.line AND m.created_at >= p_from AND m.direction = 'in' AND m.read_by = 'rules')
  FROM (VALUES ('main'), ('shop')) AS l(line)
  ORDER BY l.line
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_purge(p_before timestamptz)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_msgs int;
  v_convs int;
BEGIN
  DELETE FROM public.ttb_messages m WHERE m.created_at < p_before;
  GET DIAGNOSTICS v_msgs = ROW_COUNT;
  DELETE FROM public.ttb_conversations c WHERE c.expires_at < p_before;
  GET DIAGNOSTICS v_convs = ROW_COUNT;
  RETURN v_msgs + v_convs;
END
$fn$;

-- 8. EXECUTE: service_role only.
REVOKE ALL ON FUNCTION public.ttb_counts(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_global_prompts(timestamptz)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_overview(timestamptz)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_purge(timestamptz)              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ttb_counts(text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_global_prompts(timestamptz)     TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_overview(timestamptz)           TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_purge(timestamptz)              TO service_role;

-- 9. Default settings (value JSONB as {"value": x}). A re-run never overwrites an admin's change.
INSERT INTO public.admin_settings (key, value, description) VALUES
  ('ttb_main_enabled',              '{"value": false}'::jsonb, 'Text-to-Buy master switch for the main line. Off: the SMS webhook behaves as before.'),
  ('ttb_main_number',               '{"value": ""}'::jsonb,    'The main Text-to-Buy phone number customers text, shown in replies and on pages.'),
  ('ttb_reply_sender_id',           '{"value": ""}'::jsonb,    'Approved SMS sender ID used for Text-to-Buy replies.'),
  ('ttb_ai_enabled',                '{"value": true}'::jsonb,  'Let the AI read texts the rules cannot. Off: unread texts get the help reply.'),
  ('ttb_stale_minutes',             '{"value": 10}'::jsonb,    'A text received more than this many minutes ago is treated as late and not acted on.'),
  ('ttb_prompts_per_hour',          '{"value": 3}'::jsonb,     'Most MoMo prompts one sender may trigger per hour.'),
  ('ttb_replies_per_hour',          '{"value": 6}'::jsonb,     'Most replies one sender may be sent per hour.'),
  ('ttb_ai_reads_per_hour',         '{"value": 10}'::jsonb,    'Most AI reads one sender may use per hour.'),
  ('ttb_global_prompts_per_minute', '{"value": 30}'::jsonb,    'Most MoMo prompts across all senders per minute.'),
  ('ttb_prompt_window_minutes',     '{"value": 5}'::jsonb,     'An unpaid prompt blocks a new order from the same sender for this many minutes.'),
  ('ttb_quiet_alert_minutes',       '{"value": 60}'::jsonb,    'Alert admins when a line has received no text for this many minutes.'),
  ('ttb_retention_days',            '{"value": 30}'::jsonb,    'Delete stored texts and replies after this many days.')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verify after apply (read-only):
--   SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.oid IN ('public.ttb_messages'::regclass, 'public.ttb_conversations'::regclass,
--     'public.ttb_orders'::regclass, 'public.ttb_blocked'::regclass, 'public.ttb_heartbeat'::regclass);   -- 5 rows, all true
--   SELECT count(*) FROM pg_policies WHERE tablename LIKE 'ttb\_%';                                        -- 0
--   SELECT key, value FROM admin_settings WHERE key LIKE 'ttb\_%' ORDER BY key;                            -- 12 rows; ttb_main_enabled = {"value": false}
--   SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname LIKE 'ttb\_%';   -- 4 rows: false, false, true
