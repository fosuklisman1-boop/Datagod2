-- 0121_verify.sql — rollback-only verification for 0121_ussd_shop_free_activation.sql. NEVER apply as a migration.
-- Paste the full body of 0121_ussd_shop_free_activation.sql here before running.
BEGIN;
-- (paste 0121 body here)

-- Case A: fee 0 -> new code is open + waived on both channels
UPDATE app_settings SET ussd_shop_activation_fee = 0, whatsapp_shop_activation_fee = 0 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code) SELECT id, '99999901' FROM user_shops LIMIT 1;
SELECT 'A' AS case_, status, activation_fee_paid, activation_fee_waived, whatsapp_activated, whatsapp_activation_waived
  FROM ussd_shop_codes WHERE code = '99999901';
-- expect: active, true, true, true, true
DELETE FROM ussd_shop_codes WHERE code = '99999901';

-- Case B: fee > 0 -> new code is inactive, earlier open codes unchanged (grandfathered)
UPDATE app_settings SET ussd_shop_activation_fee = 20, whatsapp_shop_activation_fee = 20 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code) SELECT id, '99999902' FROM user_shops LIMIT 1;
SELECT 'B' AS case_, status, activation_fee_paid, activation_fee_waived, whatsapp_activated
  FROM ussd_shop_codes WHERE code = '99999902';
-- expect: inactive, false, false, false
SELECT 'B-grandfathered' AS case_, count(*) FILTER (WHERE status <> 'active') AS not_active
  FROM ussd_shop_codes WHERE activation_fee_waived = true;
-- expect: not_active = 0
DELETE FROM ussd_shop_codes WHERE code = '99999902';

-- Case C: WhatsApp fee 0, USSD fee > 0 -> WhatsApp waived but code stays inactive
UPDATE app_settings SET ussd_shop_activation_fee = 20, whatsapp_shop_activation_fee = 0 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code) SELECT id, '99999903' FROM user_shops LIMIT 1;
SELECT 'C' AS case_, status, whatsapp_activated FROM ussd_shop_codes WHERE code = '99999903';
-- expect: inactive, true

-- Case D: an insert as 'suspended' is never opened
UPDATE app_settings SET ussd_shop_activation_fee = 0, whatsapp_shop_activation_fee = 0 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code, status) SELECT id, '99999904', 'suspended' FROM user_shops LIMIT 1;
SELECT 'D' AS case_, status, activation_fee_paid, whatsapp_activated FROM ussd_shop_codes WHERE code = '99999904';
-- expect: suspended, false, false

-- Backfill effect
SELECT 'backfill' AS case_, status, count(*) FROM ussd_shop_codes GROUP BY status;

ROLLBACK;
