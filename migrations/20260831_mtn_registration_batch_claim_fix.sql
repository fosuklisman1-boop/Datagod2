-- Fixes "Failed to claim new numbers" on /admin/mtn-registration.
--
-- Root cause: claim_mtn_registration_batch() claimed ALL pending rows in one
-- UPDATE. With the registry now at 100k+ pending (grown from the 66,373-row
-- Phase 1 seed via ongoing capture triggers), that UPDATE + ORDER BY sort +
-- jsonb_agg took ~12.8s (confirmed via EXPLAIN ANALYZE). PostgREST's
-- `authenticator` login role has `statement_timeout=8s` — and `SET LOCAL
-- ROLE service_role` (which PostgREST issues per-request) does NOT reset a
-- session-level GUC established at login, so every service-role RPC call
-- through PostgREST/supabase-js inherits that 8s cap. The claim was reliably
-- getting killed by Postgres (57014 query_canceled) before it could finish.
--
-- Fix: (1) add a composite index so selecting the oldest N pending rows no
-- longer requires sorting the entire pending set, (2) bound each claim to a
-- batch the function can comfortably finish within the timeout, using
-- FOR UPDATE SKIP LOCKED for the same concurrent-admin safety as before, and
-- (3) raise the timeout for just this function call as defense-in-depth. The
-- admin UI already reports "Downloaded N new numbers" and refreshes the
-- pending count after each export, so an admin with more than one batch
-- pending simply clicks "Download" again — no UI change needed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS mtn_registry_status_seen_idx
  ON mtn_number_registry(status, first_seen_at);

CREATE OR REPLACE FUNCTION claim_mtn_registration_batch(p_admin_id uuid, p_admin_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id   uuid := gen_random_uuid();
  v_phones     jsonb;
  v_count      integer;
  v_batch_size constant integer := 20000;
BEGIN
  -- Defense-in-depth: even with the index + batch cap keeping this fast in
  -- practice, give this specific call generous headroom over the 8s the
  -- authenticator/service_role connection otherwise inherits.
  PERFORM set_config('statement_timeout', '30000', true);

  WITH to_claim AS (
    SELECT id
    FROM mtn_number_registry
    WHERE status = 'pending'
    ORDER BY first_seen_at
    LIMIT v_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE mtn_number_registry
    SET status = 'submitted',
        submitted_at = now(),
        submitted_batch = v_batch_id,
        updated_at = now()
    WHERE id IN (SELECT id FROM to_claim)
    RETURNING phone, first_seen_at
  )
  SELECT COALESCE(jsonb_agg(phone ORDER BY first_seen_at), '[]'::jsonb), COUNT(*)
  INTO v_phones, v_count
  FROM claimed;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('batch_id', NULL, 'count', 0, 'phones', '[]'::jsonb);
  END IF;

  INSERT INTO mtn_registration_batches (id, phones, number_count, status, downloaded_by, downloaded_by_email)
  VALUES (v_batch_id, v_phones, v_count, 'submitted', p_admin_id, p_admin_email);

  RETURN jsonb_build_object('batch_id', v_batch_id, 'count', v_count, 'phones', v_phones);
END;
$$;

REVOKE ALL ON FUNCTION claim_mtn_registration_batch(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_mtn_registration_batch(uuid, text) TO service_role;
