-- 0137_leaderboard_delivery.sql
--
-- Prize delivery (Phase 5 of docs/superpowers/plans/2026-10-26-leaderboard-rewards.md).
-- Needs 0133, 0135, 0136.
--
--   leaderboard_deliveries                        one row per winner's prize delivery
--   leaderboard_delivery_start(result, admin)     claim a delivery (locks; refuses delivered / in-flight / cancelled)
--   leaderboard_delivery_finish(id, status, ..)   record the outcome of a started delivery
--   leaderboard_delivery_mark(result, admin, ..)  admin marks a prize delivered by hand
--   leaderboard_grant_dealer_days(user, days, ..) dealer-upgrade prize via the existing dealer subscriptions
--   leaderboard_prize_cancel                      replaced: refuses once delivery has started
--   refresh_leaderboard_totals                    replaced: GH₵0 rows (prize orders) are not counted
--
-- Delivery states: in_progress (claimed, being sent), sent (an order was
-- created and handed to fulfilment; it completes with that order), delivered,
-- failed (can be retried). A start on an in_progress row younger than 2 minutes
-- is refused, so two clicks cannot send twice; an older one is treated as
-- abandoned and retried (wallet credits are idempotent by reference, data and
-- airtime retries reuse the order already created).
--
-- Dealer upgrades reuse user_subscriptions, whose expiry job demotes a dealer
-- as soon as ANY active subscription has ended. So an existing subscription is
-- EXTENDED rather than stacked, and only role 'user' is upgraded; a permanent
-- dealer (no subscription), sub-agent or admin is refused (deliver by hand).
--
-- SECURITY DEFINER functions with a pinned search_path, executable by
-- service_role only. NOT YET APPLIED. Apply after 0136.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.leaderboard_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id        uuid NOT NULL UNIQUE REFERENCES public.leaderboard_results(id) ON DELETE CASCADE,
  prize_id         uuid NOT NULL REFERENCES public.leaderboard_prizes(id),
  user_id          uuid NOT NULL,
  prize_type       text NOT NULL,
  status           text NOT NULL CHECK (status IN ('in_progress','sent','delivered','failed')),
  recipient_phone  text,
  order_table      text CHECK (order_table IS NULL OR order_table IN ('orders','airtime_orders')),
  order_id         text,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  note             text,
  started_at       timestamptz,
  delivered_at     timestamptz,
  delivered_by     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leaderboard_deliveries_prize_idx ON public.leaderboard_deliveries (prize_id);

ALTER TABLE public.leaderboard_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leaderboard_deliveries FROM anon, authenticated;

-- ───────────────────────── start ─────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_delivery_start(p_result_id uuid, p_admin uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r   public.leaderboard_results;
  pz  public.leaderboard_prizes;
  per public.leaderboard_periods;
  d   public.leaderboard_deliveries;
BEGIN
  SELECT * INTO r FROM public.leaderboard_results WHERE id = p_result_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'result_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO per FROM public.leaderboard_periods WHERE id = r.period_id;
  IF r.prize_id IS NULL OR per.status <> 'closed' THEN
    RAISE EXCEPTION 'no_prize' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO pz FROM public.leaderboard_prizes WHERE id = r.prize_id FOR UPDATE;
  IF pz.status <> 'active' THEN
    RAISE EXCEPTION 'prize_cancelled' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.leaderboard_deliveries (result_id, prize_id, user_id, prize_type, status)
  VALUES (r.id, pz.id, r.user_id, pz.prize_type, 'failed')
  ON CONFLICT (result_id) DO NOTHING;

  SELECT * INTO d FROM public.leaderboard_deliveries WHERE result_id = r.id FOR UPDATE;
  IF d.status = 'delivered' THEN
    RAISE EXCEPTION 'already_delivered' USING ERRCODE = '55000';
  END IF;
  IF d.status = 'in_progress' AND d.started_at > now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'delivery_in_progress' USING ERRCODE = '55000';
  END IF;

  UPDATE public.leaderboard_deliveries
     SET status = 'in_progress', attempts = attempts + 1, started_at = now(), last_error = NULL, updated_at = now()
   WHERE id = d.id
  RETURNING * INTO d;

  RETURN jsonb_build_object(
    'delivery', to_jsonb(d),
    'prize', to_jsonb(pz),
    'result', jsonb_build_object('id', r.id, 'board', r.board, 'rank', r.rank, 'user_id', r.user_id)
  );
END
$$;

-- ───────────────────────── finish ─────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_delivery_finish(
  p_delivery_id uuid, p_status text, p_admin uuid,
  p_error text DEFAULT NULL, p_order_table text DEFAULT NULL, p_order_id text DEFAULT NULL,
  p_phone text DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS public.leaderboard_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.leaderboard_deliveries;
BEGIN
  IF p_status NOT IN ('in_progress','sent','delivered','failed') THEN
    RAISE EXCEPTION 'bad_status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.leaderboard_deliveries
     SET status          = p_status,
         last_error      = CASE WHEN p_status = 'failed' THEN left(p_error, 500) ELSE NULL END,
         order_table     = COALESCE(p_order_table, order_table),
         order_id        = COALESCE(p_order_id, order_id),
         recipient_phone = COALESCE(p_phone, recipient_phone),
         note            = COALESCE(p_note, note),
         delivered_at    = CASE WHEN p_status IN ('sent','delivered') THEN now() ELSE delivered_at END,
         delivered_by    = CASE WHEN p_status IN ('sent','delivered') THEN p_admin ELSE delivered_by END,
         updated_at      = now()
   WHERE id = p_delivery_id AND status = 'in_progress'
  RETURNING * INTO d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_not_in_progress' USING ERRCODE = '55000';
  END IF;
  RETURN d;
END
$$;

-- ───────────────────────── mark delivered by hand ─────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_delivery_mark(p_result_id uuid, p_admin uuid, p_note text)
RETURNS public.leaderboard_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r  public.leaderboard_results;
  pz public.leaderboard_prizes;
  d  public.leaderboard_deliveries;
BEGIN
  SELECT * INTO r FROM public.leaderboard_results WHERE id = p_result_id;
  IF NOT FOUND OR r.prize_id IS NULL THEN
    RAISE EXCEPTION 'no_prize' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO pz FROM public.leaderboard_prizes WHERE id = r.prize_id FOR UPDATE;
  IF pz.status <> 'active' THEN
    RAISE EXCEPTION 'prize_cancelled' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.leaderboard_deliveries (result_id, prize_id, user_id, prize_type, status)
  VALUES (r.id, pz.id, r.user_id, pz.prize_type, 'failed')
  ON CONFLICT (result_id) DO NOTHING;
  SELECT * INTO d FROM public.leaderboard_deliveries WHERE result_id = r.id FOR UPDATE;
  IF d.status = 'delivered' THEN
    RAISE EXCEPTION 'already_delivered' USING ERRCODE = '55000';
  END IF;
  IF d.status = 'in_progress' AND d.started_at > now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'delivery_in_progress' USING ERRCODE = '55000';
  END IF;

  UPDATE public.leaderboard_deliveries
     SET status = 'delivered', note = left(NULLIF(btrim(p_note), ''), 500), last_error = NULL,
         delivered_at = now(), delivered_by = p_admin, updated_at = now()
   WHERE id = d.id
  RETURNING * INTO d;
  RETURN d;
END
$$;

-- ───────────────────────── dealer-upgrade prize ─────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_grant_dealer_days(p_user_id uuid, p_days integer, p_reference text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_sub  record;
  v_end  timestamptz;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'bad_days' USING ERRCODE = '22023';
  END IF;
  -- A retry after a success that was not recorded: the subscription already exists.
  SELECT id, end_date INTO v_sub FROM public.user_subscriptions WHERE payment_reference = p_reference LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('action', 'already', 'end_date', v_sub.end_date);
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, end_date INTO v_sub
    FROM public.user_subscriptions
   WHERE user_id = p_user_id AND status = 'active' AND end_date > now()
   ORDER BY end_date DESC LIMIT 1
   FOR UPDATE;

  IF FOUND AND v_role IN ('dealer', 'user') THEN
    -- Extend, never stack: the expiry job demotes on ANY ended active subscription.
    UPDATE public.user_subscriptions
       SET end_date = end_date + make_interval(days => p_days), updated_at = now()
     WHERE id = v_sub.id
    RETURNING end_date INTO v_end;
    IF v_role = 'user' THEN
      UPDATE public.users SET role = 'dealer', updated_at = now() WHERE id = p_user_id;
    END IF;
    RETURN jsonb_build_object('action', 'extended', 'end_date', v_end);
  END IF;

  IF v_role = 'user' THEN
    INSERT INTO public.user_subscriptions (user_id, plan_id, start_date, end_date, status, payment_reference, amount_paid)
    VALUES (p_user_id, NULL, now(), now() + make_interval(days => p_days), 'active', p_reference, 0)
    RETURNING end_date INTO v_end;
    UPDATE public.users SET role = 'dealer', updated_at = now() WHERE id = p_user_id;
    RETURN jsonb_build_object('action', 'created', 'end_date', v_end);
  END IF;

  RAISE EXCEPTION 'not_upgradable' USING ERRCODE = '55000', DETAIL = COALESCE(v_role, 'unknown');
END
$$;

-- ───────────────────────── cancel: refuse once delivery has started ─────────────────────────
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
  PERFORM 1 FROM public.leaderboard_prizes WHERE id = p_prize_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.leaderboard_deliveries
              WHERE prize_id = p_prize_id AND status IN ('in_progress','sent','delivered')) THEN
    RAISE EXCEPTION 'prize_delivered' USING ERRCODE = '55000';
  END IF;

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

-- ───────────────────────── refresh: ignore GH₵0 rows ─────────────────────────
-- Prize orders are created at GH₵0 so they reach fulfilment like any order;
-- they must not add to anyone's order count.
CREATE OR REPLACE FUNCTION public.refresh_leaderboard_totals(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'refresh_leaderboard_totals: invalid range % .. %', p_from, p_to;
  END IF;
  IF p_to - p_from > 92 THEN
    RAISE EXCEPTION 'refresh_leaderboard_totals: range over 93 days, refresh in chunks';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('leaderboard_refresh'));

  DELETE FROM public.leaderboard_daily_totals
   WHERE day BETWEEN p_from AND p_to;

  INSERT INTO public.leaderboard_daily_totals (board, day, user_id, total_amount, order_count, last_sale_at)
  SELECT e.board,
         (e.sold_at AT TIME ZONE 'Africa/Accra')::date,
         e.user_id,
         round(sum(e.amount), 2),
         count(*),
         max(e.sold_at)
    FROM public.leaderboard_sales_events e
   WHERE e.sold_at >= (p_from::timestamp AT TIME ZONE 'Africa/Accra')
     AND e.sold_at <  ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Accra')
     AND e.amount > 0
   GROUP BY 1, 2, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

REVOKE ALL ON FUNCTION public.leaderboard_delivery_start(uuid, uuid)                                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_delivery_finish(uuid, text, uuid, text, text, text, text, text)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_delivery_mark(uuid, uuid, text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_grant_dealer_days(uuid, integer, text)                           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_delivery_start(uuid, uuid)                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_delivery_finish(uuid, text, uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_delivery_mark(uuid, uuid, text)                               TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_grant_dealer_days(uuid, integer, text)                        TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT to_regclass('public.leaderboard_deliveries');
