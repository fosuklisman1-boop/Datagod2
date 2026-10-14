-- 0121_ussd_shop_free_activation.sql
-- USSD/WhatsApp shop session tokens are retired (spec 2026-10-14-ussd-shop-free-sessions-design.md).
-- A shop is open when its code is status='active'. While the admin's activation fee is 0, every
-- new code is written open (fee waived). Raising the fee later only affects codes inserted after
-- that: already-open codes keep status='active' (grandfathered), because status is written once.
-- BEFORE INSERT on ussd_shop_codes covers every insert path: auto_assign_ussd_shop_code(), the
-- admin "New Shop Code" route and the dealer activate route's fallback insert.

ALTER TABLE ussd_shop_codes
  ADD COLUMN IF NOT EXISTS activation_fee_waived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_activation_waived boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ussd_shop_code_apply_free_activation()
RETURNS TRIGGER AS $$
DECLARE
  v_ussd_fee numeric := 0;
  v_wa_fee   numeric := 0;
BEGIN
  SELECT COALESCE(ussd_shop_activation_fee, 0), COALESCE(whatsapp_shop_activation_fee, 0)
    INTO v_ussd_fee, v_wa_fee
    FROM app_settings
   WHERE key IS NULL
   LIMIT 1;
  -- No settings row: SELECT INTO leaves NULLs, so treat as fee 0 (open), as the app's `?? 0` reads do.
  v_ussd_fee := COALESCE(v_ussd_fee, 0);
  v_wa_fee   := COALESCE(v_wa_fee, 0);

  IF v_ussd_fee = 0 AND NEW.status = 'inactive' AND COALESCE(NEW.activation_fee_paid, false) = false THEN
    NEW.status                := 'active';
    NEW.activation_fee_paid   := true;
    NEW.activation_paid_at    := now();
    NEW.activation_fee_waived := true;
  END IF;

  IF v_wa_fee = 0 AND COALESCE(NEW.whatsapp_activated, false) = false AND NEW.status <> 'suspended' THEN
    NEW.whatsapp_activated         := true;
    NEW.whatsapp_activated_at      := now();
    NEW.whatsapp_activation_waived := true;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trigger_ussd_shop_code_free_activation ON ussd_shop_codes;
CREATE TRIGGER trigger_ussd_shop_code_free_activation
  BEFORE INSERT ON ussd_shop_codes
  FOR EACH ROW
  EXECUTE FUNCTION ussd_shop_code_apply_free_activation();

-- One-off backfill: open existing unpaid codes when the matching fee is 0. Suspended codes are untouched.
DO $$
DECLARE
  v_ussd_fee numeric := 0;
  v_wa_fee   numeric := 0;
BEGIN
  SELECT COALESCE(ussd_shop_activation_fee, 0), COALESCE(whatsapp_shop_activation_fee, 0)
    INTO v_ussd_fee, v_wa_fee
    FROM app_settings WHERE key IS NULL LIMIT 1;
  v_ussd_fee := COALESCE(v_ussd_fee, 0);
  v_wa_fee   := COALESCE(v_wa_fee, 0);

  IF v_ussd_fee = 0 THEN
    UPDATE ussd_shop_codes
       SET status = 'active', activation_fee_paid = true, activation_paid_at = now(),
           activation_fee_waived = true, updated_at = now()
     WHERE status = 'inactive' AND activation_fee_paid = false;
  END IF;

  IF v_wa_fee = 0 THEN
    UPDATE ussd_shop_codes
       SET whatsapp_activated = true, whatsapp_activated_at = now(),
           whatsapp_activation_waived = true, updated_at = now()
     WHERE COALESCE(whatsapp_activated, false) = false AND status <> 'suspended';
  END IF;
END $$;
