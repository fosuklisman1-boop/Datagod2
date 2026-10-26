-- LOCAL ONLY. Run after the 0133 and 0135 local tests in the same throwaway
-- database (it reuses their stub schema and fixtures):
--
--   psql -v ON_ERROR_STOP=1 -d lb_test -f migrations/tests/0136_leaderboard_close_local_test.sql
--
-- Passes when it prints LEADERBOARD_CLOSE_LOCAL_TEST_OK.

\set ON_ERROR_STOP 1

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title varchar(255) NOT NULL,
  message text NOT NULL, type varchar(50) NOT NULL, read boolean DEFAULT false,
  reference_id varchar(255), action_url varchar(500), created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

\i migrations/0136_leaderboard_close.sql

DO $$
DECLARE
  admin uuid := '00000000-0000-0000-0000-00000000000d';
  p public.leaderboard_periods;
  cur public.leaderboard_periods;
  v jsonb;
  n int;
  msg text;
BEGIN
  ASSERT lb_mask_name('Anthony', 'Asare') = 'Anthony A.', 'mask 1';
  ASSERT lb_mask_name('  Abdul Gafar ', 'musah') = 'Abdul M.', 'mask 2';
  ASSERT lb_mask_name(NULL, 'Mensah') = 'M.' AND lb_mask_name('Kofi', '') = 'Kofi' AND lb_mask_name(NULL, NULL) = 'Seller', 'mask 3';

  -- A past day with the stub fixtures (2026-10-10). The 0135 test closed October directly; use a daily period.
  p := leaderboard_period_ensure('daily', '2026-10-10', '2026-10-10');
  UPDATE leaderboard_periods SET rewards_enabled = true WHERE id = p.id;

  -- prizes missing -> refused
  BEGIN
    PERFORM leaderboard_close_period(p.id, true, admin, '10 October 2026');
    RAISE EXCEPTION 'closed without prizes';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    ASSERT msg = 'prizes_missing', msg;
  END;

  PERFORM leaderboard_prize_set(p.id, 'dashboard', 1, '{"prize_type":"wallet_topup","label":"GH₵50 Cash","amount":50}', admin);
  PERFORM leaderboard_prize_set(p.id, 'dashboard', 2, '{"prize_type":"manual","label":"T-shirt"}', admin);
  PERFORM leaderboard_prize_set(p.id, 'dashboard', 3, '{"prize_type":"manual","label":"Cap"}', admin);
  PERFORM leaderboard_prize_set(p.id, 'shop', 1, '{"prize_type":"wallet_topup","label":"GH₵100 Cash","amount":100}', admin);
  PERFORM leaderboard_prize_set(p.id, 'shop', 2, '{"prize_type":"manual","label":"Mug"}', admin);
  PERFORM leaderboard_prize_set(p.id, 'shop', 3, '{"prize_type":"manual","label":"Pen"}', admin);

  v := leaderboard_close_period(p.id, true, admin, '10 October 2026');
  ASSERT v->>'status' = 'closed', format('close: %s', v);

  -- Dashboard on 10-10 (after the 0133 test's refund): G, H, F at 40, A at 20, C at 12 = 5 rows; shop B, C = 2 rows
  ASSERT (v->>'results')::int = 7, format('results: %s', v);
  -- podium: dashboard ranks 1-3 + shop ranks 1-2
  ASSERT (v->>'notified')::int = 5, format('notified: %s', v);

  SELECT count(*) INTO n FROM leaderboard_results WHERE period_id = p.id AND prize_id IS NOT NULL;
  ASSERT n = 5, format('prizes attached to %s results', n);
  SELECT count(*) INTO n FROM leaderboard_results WHERE period_id = p.id AND rank > 3 AND prize_id IS NOT NULL;
  ASSERT n = 0, 'prize attached beyond rank 3';
  SELECT message INTO msg FROM notifications n JOIN leaderboard_results r ON r.id::text = n.reference_id
   WHERE r.period_id = p.id AND r.board = 'shop' AND r.rank = 1;
  ASSERT msg = 'You finished #1 in Top shop sales for 10 October 2026 and won GH₵100 Cash. We will deliver it to you soon.', msg;
  SELECT count(*) INTO n FROM leaderboard_results WHERE period_id = p.id AND display_name = 'Gina G.' AND rank = 1 AND board = 'dashboard';
  ASSERT n = 1, 'masked winner name';

  -- closing twice is refused and notifies nobody again
  BEGIN
    PERFORM leaderboard_close_period(p.id, true, admin, '10 October 2026');
    RAISE EXCEPTION 'closed twice';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    ASSERT msg = 'period_closed', msg;
  END;
  SELECT count(*) INTO n FROM notifications;
  ASSERT n = 5, format('notifications after second close: %s', n);

  -- close without rewards: no prizes, still notifies the podium, status closed_no_reward
  p := leaderboard_period_ensure('daily', '2026-10-09', '2026-10-09');
  v := leaderboard_close_period(p.id, false, admin, '9 October 2026');
  ASSERT v->>'status' = 'closed_no_reward' AND (v->>'results')::int = 1 AND (v->>'notified')::int = 1, format('no reward: %s', v);
  SELECT message INTO msg FROM notifications WHERE message LIKE '%9 October 2026%';
  ASSERT msg = 'You finished #1 in Top dashboard sales for 9 October 2026. Well done!', msg;

  -- a period that has not ended cannot close
  cur := leaderboard_period_ensure('daily', (now() AT TIME ZONE 'Africa/Accra')::date, (now() AT TIME ZONE 'Africa/Accra')::date);
  BEGIN
    PERFORM leaderboard_close_period(cur.id, false, admin, 'today');
    RAISE EXCEPTION 'closed an open day';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    ASSERT msg = 'period_not_ended', msg;
  END;

  -- rewards close needs the rewards switch on
  p := leaderboard_period_ensure('daily', '2026-10-08', '2026-10-08');
  BEGIN
    PERFORM leaderboard_close_period(p.id, true, admin, '8 October 2026');
    RAISE EXCEPTION 'rewards close with rewards off';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    ASSERT msg = 'rewards_off', msg;
  END;

  RAISE NOTICE 'LEADERBOARD_CLOSE_LOCAL_TEST_OK';
END $$;
