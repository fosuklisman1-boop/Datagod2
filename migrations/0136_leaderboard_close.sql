-- 0136_leaderboard_close.sql
--
-- Close a leaderboard period and freeze its results (Phase 4 of
-- docs/superpowers/plans/2026-10-26-leaderboard-rewards.md). Needs 0133 + 0135.
--
--   leaderboard_results                            frozen top 30 per board; ranks 1-3 carry the prize
--   lb_mask_name(first, last)                      "Anthony A." (same rules as maskName in lib/leaderboard/service.ts)
--   leaderboard_close_period(period, rewards, ..)  validate, refresh the last days, freeze, notify winners, close
--
-- Everything in the close happens in one transaction under the period row
-- lock: results, winner notifications and the status change commit together or
-- not at all, and a second close fails with period_closed instead of
-- notifying anyone twice. The caller refreshes long periods month by month
-- first; the close itself re-refreshes only the last 8 days (late completions
-- and refunds) so it stays fast.
--
-- SECURITY DEFINER with a pinned search_path, executable by service_role only.
-- NOT YET APPLIED. Apply after 0135.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.leaderboard_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id     uuid NOT NULL REFERENCES public.leaderboard_periods(id) ON DELETE CASCADE,
  board         text NOT NULL CHECK (board IN ('dashboard','shop')),
  rank          smallint NOT NULL CHECK (rank BETWEEN 1 AND 100),
  user_id       uuid NOT NULL,
  display_name  text NOT NULL,
  total_amount  numeric(14,2) NOT NULL,
  order_count   integer NOT NULL,
  prize_id      uuid REFERENCES public.leaderboard_prizes(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, board, rank)
);
CREATE INDEX IF NOT EXISTS leaderboard_results_user_idx ON public.leaderboard_results (user_id);

ALTER TABLE public.leaderboard_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leaderboard_results FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.lb_mask_name(p_first text, p_last text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN f = '' AND l = '' THEN 'Seller'
    WHEN f = '' THEN upper(left(l, 1)) || '.'
    WHEN l = '' THEN f
    ELSE f || ' ' || upper(left(l, 1)) || '.'
  END
  FROM (SELECT split_part(btrim(COALESCE(p_first, '')), ' ', 1) AS f, btrim(COALESCE(p_last, '')) AS l) n
$$;

CREATE OR REPLACE FUNCTION public.leaderboard_close_period(
  p_period_id uuid, p_with_rewards boolean, p_admin uuid, p_period_label text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period   public.leaderboard_periods;
  v_today    date := (now() AT TIME ZONE 'Africa/Accra')::date;
  v_missing  int;
  v_results  int;
  v_notified int;
  v_board    text;
BEGIN
  SELECT * INTO v_period FROM public.leaderboard_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'period_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_period.status <> 'open' THEN
    RAISE EXCEPTION 'period_closed' USING ERRCODE = '55000';
  END IF;
  IF v_period.ends_on >= v_today THEN
    RAISE EXCEPTION 'period_not_ended' USING ERRCODE = '55000';
  END IF;
  IF p_with_rewards THEN
    IF NOT v_period.rewards_enabled THEN
      RAISE EXCEPTION 'rewards_off' USING ERRCODE = '55000';
    END IF;
    SELECT 6 - count(*) INTO v_missing
      FROM public.leaderboard_prizes
     WHERE period_id = p_period_id AND status = 'active';
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'prizes_missing' USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Final refresh of the last days; the caller refreshed the rest of the period.
  PERFORM public.refresh_leaderboard_totals(GREATEST(v_period.starts_on, v_period.ends_on - 7), v_period.ends_on);

  FOREACH v_board IN ARRAY ARRAY['dashboard', 'shop'] LOOP
    INSERT INTO public.leaderboard_results (period_id, board, rank, user_id, display_name, total_amount, order_count, prize_id)
    SELECT p_period_id, v_board, r.rank, r.user_id, public.lb_mask_name(r.first_name, r.last_name),
           r.total_amount, r.order_count, p.id
      FROM public.leaderboard_ranked(v_board, v_period.starts_on, v_period.ends_on) r
      LEFT JOIN public.leaderboard_prizes p
        ON p_with_rewards AND p.period_id = p_period_id AND p.board = v_board AND p.rank = r.rank AND p.status = 'active'
     WHERE r.rank <= 30;
  END LOOP;
  SELECT count(*) INTO v_results FROM public.leaderboard_results WHERE period_id = p_period_id;

  INSERT INTO public.notifications (user_id, title, message, type, read, reference_id, action_url)
  SELECT res.user_id,
         CASE WHEN pr.id IS NOT NULL THEN 'You won a Top Performers prize!' ELSE 'You made the Top Performers podium!' END,
         format('You finished #%s in %s for %s', res.rank,
                CASE res.board WHEN 'dashboard' THEN 'Top dashboard sales' ELSE 'Top shop sales' END, p_period_label)
           || CASE WHEN pr.id IS NOT NULL THEN format(' and won %s. We will deliver it to you soon.', pr.label) ELSE '. Well done!' END,
         'leaderboard_win', false, res.id::text, '/dashboard/top-performers'
    FROM public.leaderboard_results res
    LEFT JOIN public.leaderboard_prizes pr ON pr.id = res.prize_id
   WHERE res.period_id = p_period_id AND res.rank <= 3;
  GET DIAGNOSTICS v_notified = ROW_COUNT;

  UPDATE public.leaderboard_periods
     SET status = CASE WHEN p_with_rewards THEN 'closed' ELSE 'closed_no_reward' END,
         closed_at = now(), closed_by = p_admin, updated_at = now()
   WHERE id = p_period_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN p_with_rewards THEN 'closed' ELSE 'closed_no_reward' END,
    'results', v_results,
    'notified', v_notified
  );
END
$$;

REVOKE ALL ON FUNCTION public.lb_mask_name(text, text)                                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_close_period(uuid, boolean, uuid, text)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lb_mask_name(text, text)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_close_period(uuid, boolean, uuid, text)  TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT to_regclass('public.leaderboard_results');
--   SELECT public.lb_mask_name('Anthony', 'Asare');   -- Anthony A.
