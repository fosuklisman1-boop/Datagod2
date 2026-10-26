-- 0135_leaderboard_rewards.sql
--
-- Leaderboard rewards setup (Phase 3 of
-- docs/superpowers/plans/2026-10-26-leaderboard-rewards.md). Needs 0133.
--
--   leaderboard_periods                         one row per rewarded/configured period
--   leaderboard_prizes                          ranks 1-3 per board; cancelled rows are kept as history
--   leaderboard_prize_presets                   reusable prize templates (admin Presets tab)
--   leaderboard_period_ensure(kind,start,end)   get-or-create a standard period (race-safe)
--   leaderboard_prize_set(period,board,rank,..) create or replace the active prize of a rank
--   leaderboard_prize_cancel(prize,admin)       cancel a prize; it can never be reassigned
--
-- A period's prizes can only be set while it is 'open'. Every write locks the
-- period row first, so the close-period RPC (Phase 4) cannot race a prize edit.
-- Cancelling keeps the row (status 'cancelled') and frees the rank for a new
-- prize while the period is open.
--
-- SECURITY DEFINER functions with a pinned search_path, executable by
-- service_role only; tables have RLS on with no grants to anon/authenticated.
--
-- NOT YET APPLIED. Apply after 0133.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.leaderboard_periods (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('daily','weekly','monthly','yearly','custom')),
  title            text,
  description      text,
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  rewards_enabled  boolean NOT NULL DEFAULT false,
  is_published     boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','closed_no_reward')),
  closed_at        timestamptz,
  closed_by        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_periods_standard_uniq
  ON public.leaderboard_periods (kind, starts_on) WHERE kind <> 'custom';

CREATE TABLE IF NOT EXISTS public.leaderboard_prizes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id      uuid NOT NULL REFERENCES public.leaderboard_periods(id) ON DELETE CASCADE,
  board          text NOT NULL CHECK (board IN ('dashboard','shop')),
  rank           smallint NOT NULL CHECK (rank BETWEEN 1 AND 3),
  prize_type     text NOT NULL CHECK (prize_type IN ('wallet_topup','data_bundle','airtime','role_upgrade','manual')),
  label          text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  amount         numeric(12,2),
  package_id     uuid,
  network        text,
  role           text,
  duration_days  integer,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by     uuid,
  cancelled_at   timestamptz,
  cancelled_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leaderboard_prizes_fields CHECK (
    CASE prize_type
      WHEN 'wallet_topup' THEN amount > 0 AND amount <= 100000
      WHEN 'airtime'      THEN amount > 0 AND amount <= 10000 AND network IN ('MTN','Telecel','AT')
      WHEN 'data_bundle'  THEN package_id IS NOT NULL
      WHEN 'role_upgrade' THEN role = 'dealer' AND duration_days BETWEEN 1 AND 365
      ELSE true
    END
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_prizes_active_uniq
  ON public.leaderboard_prizes (period_id, board, rank) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS leaderboard_prizes_period_idx ON public.leaderboard_prizes (period_id);

CREATE TABLE IF NOT EXISTS public.leaderboard_prize_presets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  prize_type     text NOT NULL CHECK (prize_type IN ('wallet_topup','data_bundle','airtime','role_upgrade','manual')),
  label          text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  amount         numeric(12,2),
  package_id     uuid,
  network        text,
  role           text,
  duration_days  integer,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leaderboard_prize_presets_fields CHECK (
    CASE prize_type
      WHEN 'wallet_topup' THEN amount > 0 AND amount <= 100000
      WHEN 'airtime'      THEN amount > 0 AND amount <= 10000 AND network IN ('MTN','Telecel','AT')
      WHEN 'data_bundle'  THEN package_id IS NOT NULL
      WHEN 'role_upgrade' THEN role = 'dealer' AND duration_days BETWEEN 1 AND 365
      ELSE true
    END
  )
);

ALTER TABLE public.leaderboard_periods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_prizes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_prize_presets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leaderboard_periods       FROM anon, authenticated;
REVOKE ALL ON public.leaderboard_prizes        FROM anon, authenticated;
REVOKE ALL ON public.leaderboard_prize_presets FROM anon, authenticated;

-- ───────────────────────── get-or-create a standard period ─────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_period_ensure(p_kind text, p_start date, p_end date)
RETURNS public.leaderboard_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.leaderboard_periods;
BEGIN
  IF p_kind NOT IN ('daily','weekly','monthly','yearly') THEN
    RAISE EXCEPTION 'leaderboard_period_ensure: bad kind %', p_kind USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.leaderboard_periods (kind, starts_on, ends_on)
  VALUES (p_kind, p_start, p_end)
  ON CONFLICT (kind, starts_on) WHERE kind <> 'custom' DO NOTHING;

  SELECT * INTO v FROM public.leaderboard_periods WHERE kind = p_kind AND starts_on = p_start;
  IF v.ends_on <> p_end THEN
    RAISE EXCEPTION 'leaderboard_period_ensure: % % already ends on %', p_kind, p_start, v.ends_on USING ERRCODE = '22023';
  END IF;
  RETURN v;
END
$$;

-- ───────────────────────── set / replace a rank's prize ─────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_prize_set(
  p_period_id uuid, p_board text, p_rank integer, p_prize jsonb, p_admin uuid
)
RETURNS public.leaderboard_prizes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v public.leaderboard_prizes;
BEGIN
  SELECT status INTO v_status FROM public.leaderboard_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'period_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'period_closed' USING ERRCODE = '55000';
  END IF;

  UPDATE public.leaderboard_prizes
     SET prize_type    = p_prize->>'prize_type',
         label         = btrim(p_prize->>'label'),
         amount        = (p_prize->>'amount')::numeric,
         package_id    = (p_prize->>'package_id')::uuid,
         network       = p_prize->>'network',
         role          = p_prize->>'role',
         duration_days = (p_prize->>'duration_days')::integer,
         updated_at    = now()
   WHERE period_id = p_period_id AND board = p_board AND rank = p_rank AND status = 'active'
  RETURNING * INTO v;

  IF NOT FOUND THEN
    INSERT INTO public.leaderboard_prizes
      (period_id, board, rank, prize_type, label, amount, package_id, network, role, duration_days, created_by)
    VALUES
      (p_period_id, p_board, p_rank, p_prize->>'prize_type', btrim(p_prize->>'label'),
       (p_prize->>'amount')::numeric, (p_prize->>'package_id')::uuid, p_prize->>'network',
       p_prize->>'role', (p_prize->>'duration_days')::integer, p_admin)
    RETURNING * INTO v;
  END IF;

  UPDATE public.leaderboard_periods SET updated_at = now() WHERE id = p_period_id;
  RETURN v;
END
$$;

-- ───────────────────────── cancel a prize ─────────────────────────
-- Allowed in any period state (a closed period's winner can lose a prize after
-- a refund). Phase 5 adds: refuse once the prize has been delivered.
CREATE OR REPLACE FUNCTION public.leaderboard_prize_cancel(p_prize_id uuid, p_admin uuid)
RETURNS public.leaderboard_prizes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period uuid;
  v public.leaderboard_prizes;
BEGIN
  SELECT period_id INTO v_period FROM public.leaderboard_prizes WHERE id = p_prize_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prize_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.leaderboard_periods WHERE id = v_period FOR UPDATE;

  UPDATE public.leaderboard_prizes
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_admin, updated_at = now()
   WHERE id = p_prize_id AND status = 'active'
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prize_already_cancelled' USING ERRCODE = '55000';
  END IF;
  RETURN v;
END
$$;

REVOKE ALL ON FUNCTION public.leaderboard_period_ensure(text, date, date)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_prize_set(uuid, text, integer, jsonb, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_prize_cancel(uuid, uuid)                           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_period_ensure(text, date, date)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_prize_set(uuid, text, integer, jsonb, uuid)     TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_prize_cancel(uuid, uuid)                        TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT * FROM leaderboard_period_ensure('monthly', '2026-11-01', '2026-11-30');
--   SELECT count(*) FROM leaderboard_prizes;
