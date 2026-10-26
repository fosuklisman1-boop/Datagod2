-- LOCAL ONLY. Run after the 0133, 0135 and 0136 local tests in the same
-- throwaway database (it reuses their stub schema and the closed 2026-10-10 period):
--
--   psql -v ON_ERROR_STOP=1 -d lb_test -f migrations/tests/0137_leaderboard_delivery_local_test.sql
--
-- Passes when it prints LEADERBOARD_DELIVERY_LOCAL_TEST_OK.

\set ON_ERROR_STOP 1

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, plan_id uuid,
  start_date timestamptz DEFAULT now(), end_date timestamptz NOT NULL,
  status text DEFAULT 'active', payment_reference text, amount_paid numeric(10,2),
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

\i migrations/0137_leaderboard_delivery.sql

DO $$
DECLARE
  admin uuid := '00000000-0000-0000-0000-00000000000d';
  per uuid;
  r1 uuid; r2 uuid; r3 uuid; s1 uuid;
  v jsonb;
  d public.leaderboard_deliveries;
  msg text;
  n int;
BEGIN
  SELECT id INTO per FROM leaderboard_periods WHERE kind = 'daily' AND starts_on = '2026-10-10';
  SELECT id INTO r1 FROM leaderboard_results WHERE period_id = per AND board = 'dashboard' AND rank = 1;
  SELECT id INTO r2 FROM leaderboard_results WHERE period_id = per AND board = 'dashboard' AND rank = 2;
  SELECT id INTO r3 FROM leaderboard_results WHERE period_id = per AND board = 'dashboard' AND rank = 3;
  SELECT id INTO s1 FROM leaderboard_results WHERE period_id = per AND board = 'shop' AND rank = 1;

  -- start -> in_progress; a second start right away is refused
  v := leaderboard_delivery_start(r1, admin);
  ASSERT v->'delivery'->>'status' = 'in_progress' AND (v->'delivery'->>'attempts')::int = 1, format('start: %s', v);
  ASSERT v->'prize'->>'label' = 'GH₵50 Cash' AND (v->'result'->>'rank')::int = 1, format('start payload: %s', v);
  BEGIN
    PERFORM leaderboard_delivery_start(r1, admin);
    RAISE EXCEPTION 'double start accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'delivery_in_progress', msg;
  END;

  -- failed -> can retry; attempts count up
  d := leaderboard_delivery_finish((v->'delivery'->>'id')::uuid, 'failed', admin, 'provider down');
  ASSERT d.status = 'failed' AND d.last_error = 'provider down', 'finish failed';
  v := leaderboard_delivery_start(r1, admin);
  ASSERT (v->'delivery'->>'attempts')::int = 2, 'attempts did not count up';
  d := leaderboard_delivery_finish((v->'delivery'->>'id')::uuid, 'delivered', admin);
  ASSERT d.status = 'delivered' AND d.delivered_by = admin AND d.last_error IS NULL, 'finish delivered';

  -- delivered: no restart, no cancel, no second finish
  BEGIN
    PERFORM leaderboard_delivery_start(r1, admin);
    RAISE EXCEPTION 'restart after delivery';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'already_delivered', msg;
  END;
  BEGIN
    PERFORM leaderboard_prize_cancel(d.prize_id, admin);
    RAISE EXCEPTION 'cancelled a delivered prize';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'prize_delivered', msg;
  END;
  BEGIN
    PERFORM leaderboard_delivery_finish(d.id, 'failed', admin, 'late');
    RAISE EXCEPTION 'finished a delivered row';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'delivery_not_in_progress', msg;
  END;

  -- a cancelled prize cannot be delivered or marked
  PERFORM leaderboard_prize_cancel((SELECT prize_id FROM leaderboard_results WHERE id = r2), admin);
  BEGIN
    PERFORM leaderboard_delivery_start(r2, admin);
    RAISE EXCEPTION 'delivered a cancelled prize';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'prize_cancelled', msg;
  END;

  -- manual mark, with a note; marking again is refused
  d := leaderboard_delivery_mark(r3, admin, '  Collected in person  ');
  ASSERT d.status = 'delivered' AND d.note = 'Collected in person', format('mark: %s', row_to_json(d));
  BEGIN
    PERFORM leaderboard_delivery_mark(r3, admin, 'again');
    RAISE EXCEPTION 'marked twice';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'already_delivered', msg;
  END;

  -- order details stick through finish
  v := leaderboard_delivery_start(s1, admin);
  d := leaderboard_delivery_finish((v->'delivery'->>'id')::uuid, 'sent', admin, NULL, 'orders', 'o-123', '0241234567');
  ASSERT d.status = 'sent' AND d.order_table = 'orders' AND d.order_id = 'o-123' AND d.recipient_phone = '0241234567', 'sent';

  -- dealer days: a plain user gets a new subscription and the dealer role
  v := leaderboard_grant_dealer_days('00000000-0000-0000-0000-00000000000a', 15, 'LB-test-1');
  ASSERT v->>'action' = 'created', format('grant: %s', v);
  ASSERT (SELECT role FROM users WHERE id = '00000000-0000-0000-0000-00000000000a') = 'dealer', 'role not upgraded';
  SELECT count(*) INTO n FROM user_subscriptions WHERE payment_reference = 'LB-test-1' AND amount_paid = 0
     AND end_date BETWEEN now() + interval '15 days' - interval '1 minute' AND now() + interval '15 days' + interval '1 minute';
  ASSERT n = 1, 'subscription not created for 15 days';
  -- retry with the same reference does nothing new
  v := leaderboard_grant_dealer_days('00000000-0000-0000-0000-00000000000a', 15, 'LB-test-1');
  ASSERT v->>'action' = 'already', format('retry: %s', v);
  -- an existing subscriber is extended, not stacked
  v := leaderboard_grant_dealer_days('00000000-0000-0000-0000-00000000000a', 10, 'LB-test-2');
  ASSERT v->>'action' = 'extended', format('extend: %s', v);
  SELECT count(*) INTO n FROM user_subscriptions WHERE user_id = '00000000-0000-0000-0000-00000000000a';
  ASSERT n = 1, format('stacked %s subscriptions', n);
  ASSERT (SELECT end_date FROM user_subscriptions WHERE user_id = '00000000-0000-0000-0000-00000000000a')
         > now() + interval '24 days', 'not extended by 10 days';
  -- permanent dealers, sub-agents and admins are refused
  UPDATE users SET role = 'sub_agent' WHERE id = '00000000-0000-0000-0000-00000000000c';
  BEGIN
    PERFORM leaderboard_grant_dealer_days('00000000-0000-0000-0000-00000000000c', 15, 'LB-test-3');
    RAISE EXCEPTION 'upgraded a sub-agent';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'not_upgradable', msg;
  END;
  BEGIN
    PERFORM leaderboard_grant_dealer_days('00000000-0000-0000-0000-00000000000b', 15, 'LB-test-4'); -- dealer, no subscription
    RAISE EXCEPTION 'touched a permanent dealer';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; ASSERT msg = 'not_upgradable', msg;
  END;

  -- GH₵0 prize orders do not count
  SELECT order_count INTO n FROM leaderboard_daily_totals WHERE board = 'dashboard' AND day = '2026-10-10' AND user_id = '00000000-0000-0000-0000-000000000007';
  INSERT INTO orders (user_id, price, status, created_at) VALUES ('00000000-0000-0000-0000-000000000007', 0, 'completed', '2026-10-10 12:00');
  PERFORM refresh_leaderboard_totals('2026-10-10', '2026-10-10');
  ASSERT (SELECT order_count FROM leaderboard_daily_totals WHERE board = 'dashboard' AND day = '2026-10-10'
            AND user_id = '00000000-0000-0000-0000-000000000007') = n, 'GH₵0 order counted';

  RAISE NOTICE 'LEADERBOARD_DELIVERY_LOCAL_TEST_OK';
END $$;
