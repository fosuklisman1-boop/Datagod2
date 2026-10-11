-- The 48 h "inactive before delete" rule keys off sms_bundles.updated_at. Make EVERY deactivation —
-- including a manual SQL one — restart that clock, so a bundle with a checkout still in flight can
-- never be deleted early.
BEGIN;

CREATE OR REPLACE FUNCTION sms_bundles_touch_on_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active IS DISTINCT FROM NEW.active AND NEW.active = false THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sms_bundles_touch_on_deactivate ON sms_bundles;
CREATE TRIGGER trg_sms_bundles_touch_on_deactivate
  BEFORE UPDATE OF active ON sms_bundles
  FOR EACH ROW EXECUTE FUNCTION sms_bundles_touch_on_deactivate();

COMMIT;
