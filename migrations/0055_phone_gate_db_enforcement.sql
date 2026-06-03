-- Phone gate — database backstop (Layer 1).
--
-- WHY: the user-facing withdrawal write (withdrawalService.createWithdrawalRequest)
-- runs from the browser with the user's JWT against the anon Supabase client —
-- there is NO server route in that path, so the API guard (checkPhoneVerified)
-- cannot cover it. A phone-less / unverified account could simply call
--   supabase.from('withdrawal_requests').insert(...)
-- directly and skip the modal entirely. This migration makes Postgres itself
-- reject that insert, so the gate holds no matter what the browser does.
--
-- Mirrors lib/phone-verify-guard.ts (keep the two in sync): verified OR within
-- grace OR kill-switch on → allowed; otherwise blocked. Fails CLOSED.

-- ── Helper: is the phone gate satisfied for this user? ───────────────────────
CREATE OR REPLACE FUNCTION is_phone_gate_satisfied(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_verified  boolean;
  v_deadline  timestamptz;
  v_disabled  boolean;
BEGIN
  -- Emergency kill switch (admin_settings key 'phone_gate_disabled'): same flag
  -- the UI modal and API guard read, so all layers turn off together.
  SELECT (value->>'disabled')::boolean
    INTO v_disabled
  FROM admin_settings
  WHERE key = 'phone_gate_disabled'
  LIMIT 1;

  IF COALESCE(v_disabled, false) THEN
    RETURN true;
  END IF;

  SELECT phone_verified, phone_verify_deadline
    INTO v_verified, v_deadline
  FROM users
  WHERE id = p_user;

  -- No profile row → can't confirm verification → block (fail closed).
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF COALESCE(v_verified, false) THEN
    RETURN true;
  END IF;

  -- Grace period still open.
  IF v_deadline IS NOT NULL AND v_deadline > now() THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- ── Trigger fn: block money-moving inserts by an unverified owner ─────────────
CREATE OR REPLACE FUNCTION enforce_phone_gate_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only enforce for a DIRECT authenticated-user insert of the user's OWN row
  -- (auth.uid() = NEW.user_id). Two cases are intentionally skipped:
  --   • Service-role inserts (API routes) run with auth.uid() = NULL — those
  --     paths are already gated by checkPhoneVerified at the API layer.
  --   • Anonymous storefront inserts also have auth.uid() = NULL and belong to
  --     the separate storefront-OTP control, not this account gate.
  IF auth.uid() IS NOT NULL
     AND NEW.user_id IS NOT NULL
     AND NEW.user_id = auth.uid()
     AND NOT is_phone_gate_satisfied(auth.uid())
  THEN
    RAISE EXCEPTION 'PHONE_NOT_VERIFIED: add and verify your phone number before continuing'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Attach to every money table that has a user_id column ────────────────────
-- The auth.uid() guard above makes this safe to attach broadly: it can only ever
-- block a direct client-side insert of the actor's own row. withdrawal_requests
-- is the one confirmed client-RLS path today; the order tables are belt-and-suspenders
-- in case a future client path inserts them directly.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'withdrawal_requests',
    'orders',
    'airtime_orders',
    'afa_orders',
    'results_checker_orders'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_phone_gate_%I ON public.%I', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_phone_gate_%I BEFORE INSERT ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION enforce_phone_gate_on_insert()', t, t);
    END IF;
  END LOOP;
END $$;
