-- Auto-assign a unique USSD shop code whenever a new shop is created.
-- Code is active by default so shop owners can start using it immediately.
-- Uses RAISE WARNING on collision exhaustion so shop creation is never blocked.

CREATE OR REPLACE FUNCTION auto_assign_ussd_shop_code()
RETURNS TRIGGER AS $$
DECLARE
  new_code VARCHAR(8);
  attempts INT := 0;
BEGIN
  -- Idempotent: skip if this shop already has a code
  IF EXISTS (SELECT 1 FROM ussd_shop_codes WHERE shop_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  LOOP
    new_code := LPAD(FLOOR(1000 + random() * 9000)::TEXT, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM ussd_shop_codes WHERE code = new_code);
    attempts := attempts + 1;
    IF attempts >= 20 THEN
      RAISE WARNING 'auto_assign_ussd_shop_code: could not generate unique code for shop % after 20 attempts', NEW.id;
      RETURN NEW;
    END IF;
  END LOOP;

  INSERT INTO ussd_shop_codes (shop_id, code, status, token_balance, activation_fee_paid)
  VALUES (NEW.id, new_code, 'inactive', 0, false);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_auto_assign_ussd_shop_code ON user_shops;
CREATE TRIGGER trigger_auto_assign_ussd_shop_code
  AFTER INSERT ON user_shops
  FOR EACH ROW
  EXECUTE FUNCTION auto_assign_ussd_shop_code();

-- Backfill existing shops that don't have a code yet
DO $$
DECLARE
  shop_rec RECORD;
  new_code VARCHAR(8);
  attempts INT;
BEGIN
  FOR shop_rec IN
    SELECT id FROM user_shops
    WHERE id NOT IN (SELECT shop_id FROM ussd_shop_codes)
  LOOP
    attempts := 0;
    new_code := NULL;
    LOOP
      new_code := LPAD(FLOOR(1000 + random() * 9000)::TEXT, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM ussd_shop_codes WHERE code = new_code);
      attempts := attempts + 1;
      IF attempts >= 20 THEN
        RAISE WARNING 'auto_assign_ussd_shop_code backfill: could not assign code to shop %', shop_rec.id;
        new_code := NULL;
        EXIT;
      END IF;
    END LOOP;

    IF new_code IS NOT NULL THEN
      INSERT INTO ussd_shop_codes (shop_id, code, status, token_balance, activation_fee_paid)
      VALUES (shop_rec.id, new_code, 'inactive', 0, false);
    END IF;
  END LOOP;
END;
$$;
