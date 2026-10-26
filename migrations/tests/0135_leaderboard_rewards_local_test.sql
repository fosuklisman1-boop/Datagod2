-- LOCAL ONLY. Run after 0133_leaderboard_engine_local_test.sql in the same
-- throwaway database (it reuses that stub schema):
--
--   psql -v ON_ERROR_STOP=1 -d lb_test -f migrations/tests/0135_leaderboard_rewards_local_test.sql
--
-- Passes when it prints LEADERBOARD_REWARDS_LOCAL_TEST_OK.

\set ON_ERROR_STOP 1
\i migrations/0135_leaderboard_rewards.sql

DO $$
DECLARE
  p public.leaderboard_periods;
  p2 public.leaderboard_periods;
  z public.leaderboard_prizes;
  z2 public.leaderboard_prizes;
  n int;
  admin uuid := '00000000-0000-0000-0000-00000000000d';
BEGIN
  -- ensure is idempotent and returns the same row
  p := leaderboard_period_ensure('monthly', '2026-10-01', '2026-10-31');
  p2 := leaderboard_period_ensure('monthly', '2026-10-01', '2026-10-31');
  ASSERT p.id = p2.id AND p.status = 'open' AND NOT p.rewards_enabled, 'ensure not idempotent';

  -- a mismatched end for an existing start is refused
  BEGIN
    PERFORM leaderboard_period_ensure('monthly', '2026-10-01', '2026-10-30');
    RAISE EXCEPTION 'mismatched end accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- set, then replace in place (still one active row, same id)
  z := leaderboard_prize_set(p.id, 'dashboard', 1, '{"prize_type":"wallet_topup","label":" GH₵50 CASH ","amount":50}', admin);
  ASSERT z.label = 'GH₵50 CASH' AND z.amount = 50, format('set: %s', row_to_json(z));
  z2 := leaderboard_prize_set(p.id, 'dashboard', 1, '{"prize_type":"airtime","label":"GH₵20 MTN Airtime","amount":20,"network":"MTN"}', admin);
  ASSERT z2.id = z.id AND z2.prize_type = 'airtime', 'replace did not update in place';
  SELECT count(*) INTO n FROM leaderboard_prizes WHERE period_id = p.id;
  ASSERT n = 1, format('expected 1 prize row, got %s', n);

  -- field rules per type are enforced by the table
  BEGIN
    PERFORM leaderboard_prize_set(p.id, 'shop', 2, '{"prize_type":"role_upgrade","label":"Admin forever","role":"admin","duration_days":15}', admin);
    RAISE EXCEPTION 'bad role accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM leaderboard_prize_set(p.id, 'shop', 2, '{"prize_type":"wallet_topup","label":"Nothing","amount":0}', admin);
    RAISE EXCEPTION 'zero cash accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  z := leaderboard_prize_set(p.id, 'shop', 2, '{"prize_type":"role_upgrade","label":"15 days Dealer","role":"dealer","duration_days":15}', admin);

  -- cancel keeps history, frees the slot, and cannot be repeated
  z := leaderboard_prize_cancel(z.id, admin);
  ASSERT z.status = 'cancelled' AND z.cancelled_by = admin, 'cancel failed';
  BEGIN
    PERFORM leaderboard_prize_cancel(z.id, admin);
    RAISE EXCEPTION 'double cancel accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  z2 := leaderboard_prize_set(p.id, 'shop', 2, '{"prize_type":"manual","label":"Branded T-shirt"}', admin);
  ASSERT z2.id <> z.id, 'cancelled prize was reused';
  SELECT count(*) INTO n FROM leaderboard_prizes WHERE period_id = p.id AND board = 'shop' AND rank = 2;
  ASSERT n = 2, format('expected cancelled + new, got %s', n);

  -- no edits once the period is closed
  UPDATE leaderboard_periods SET status = 'closed' WHERE id = p.id;
  BEGIN
    PERFORM leaderboard_prize_set(p.id, 'shop', 3, '{"prize_type":"manual","label":"Late"}', admin);
    RAISE EXCEPTION 'closed period accepted a prize';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  RAISE NOTICE 'LEADERBOARD_REWARDS_LOCAL_TEST_OK';
END $$;
