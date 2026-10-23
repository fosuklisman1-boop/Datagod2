-- 0131_api_v2_stats_orders.selftest.sql
--
-- NOT A MIGRATION. Self-rolling-back dry run for 0131_api_v2_stats_orders.sql.
--
-- IMPORTANT: the run string must be built by code that ASSERTS it contains no
-- COMMIT/END before sending to production. The controller will run it.
--
-- How to run (prod change protocol, dry-run step):
--   Send ONE request containing 0131_api_v2_stats_orders.sql with ONLY its
--   final `COMMIT;` line removed (keep `BEGIN;` and both SET LOCALs), followed
--   by the DO block below. The DO block always ends with RAISE EXCEPTION,
--   which aborts the explicit transaction whatever the client does, so the
--   function replacements are rolled back. If the client keeps the session
--   open afterwards, send `ROLLBACK;`. The run PASSES when the error text
--   starts with 'SELFTEST_OK'; any 'FAIL ...' or other error means it failed.
--   After the real apply the DO block can also be run alone inside
--   `BEGIN; ... ` (no COMMIT).

DO $selftest$
DECLARE
  s jsonb;
  a jsonb;
  k uuid;
BEGIN
  s := public.api_v2_admin_stats(now() - interval '24 hours');
  IF s IS NULL THEN RAISE EXCEPTION 'FAIL admin_stats returned null'; END IF;

  -- existing fields still present
  IF NOT (s ? 'keys' AND s ? 'requests' AND s ? 'ok' AND s ? 'failed'
          AND s ? 'avg_latency_ms' AND s ? 'top') THEN
    RAISE EXCEPTION 'FAIL admin_stats lost an existing field: %', s;
  END IF;

  -- new fields present and numeric
  IF jsonb_typeof(s->'revenue') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s->'revenue_lifetime') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s->'orders') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s->'pending_orders') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'FAIL admin_stats new fields missing or not numbers: %', s;
  END IF;
  IF (s->>'revenue')::numeric < 0 OR (s->>'revenue_lifetime')::numeric < (s->>'revenue')::numeric
     OR (s->>'orders')::numeric < 0 OR (s->>'pending_orders')::numeric < 0 THEN
    RAISE EXCEPTION 'FAIL admin_stats new fields inconsistent: %', s;
  END IF;

  -- per-key function: use a real key when one exists, else a random uuid (all zeros)
  SELECT id INTO k FROM public.api_v2_keys LIMIT 1;
  IF k IS NULL THEN k := gen_random_uuid(); END IF;
  a := public.api_v2_key_activity(k, now() - interval '24 hours');
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL key_activity returned null'; END IF;
  IF NOT (a ? 'requests' AND a ? 'ok' AND a ? 'failed' AND a ? 'avg_latency_ms' AND a ? 'last_used_at') THEN
    RAISE EXCEPTION 'FAIL key_activity lost an existing field: %', a;
  END IF;
  IF jsonb_typeof(a->'spent') IS DISTINCT FROM 'number'
     OR jsonb_typeof(a->'orders') IS DISTINCT FROM 'number'
     OR jsonb_typeof(a->'pending') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'FAIL key_activity new fields missing or not numbers: %', a;
  END IF;

  RAISE EXCEPTION 'SELFTEST_OK admin_stats=% key_activity=%', s, a;
END
$selftest$;
