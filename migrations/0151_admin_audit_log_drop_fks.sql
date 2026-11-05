-- 0151_admin_audit_log_drop_fks.sql
--
-- Lets a user (or an admin) be deleted while admin_audit_log rows point at them, WITHOUT losing who acted on whom.
--
-- 0069 created admin_audit_log with
--   admin_id       uuid NOT NULL REFERENCES auth.users(id)     -- admin_audit_log_admin_id_fkey
--   target_user_id uuid          REFERENCES auth.users(id)     -- admin_audit_log_target_user_id_fkey
-- both ON DELETE NO ACTION (no later migration touches them). So deleting any auth user who was ever the target
-- (or the actor) of an audited admin action failed with a foreign key violation. With bulk notifications writing
-- one audit row per user notified, that is most users: POST /api/admin/remove-user deleted the profile, wallet,
-- orders and shops and only then failed at auth.admin.deleteUser, leaving a half-deleted account.
--
-- ON DELETE SET NULL would fix the delete but erase the deleted user's / admin's id from the audit trail. Instead
-- this migration DROPS both foreign keys: the columns keep the raw uuids forever, audit rows never block a delete,
-- and a deleted account stays identifiable in the log (remove-user also records the account's email, phone and
-- role in a 'user_removed' row before deleting it). The writers always take these ids from verifyAdminAccess or
-- from an existing user, so the lost referential check costs nothing in practice.
--
-- admin_id becomes NULLABLE. Not every writer always supplies it: under the CRON_SECRET bypass (AI scheduled
-- tasks, the WhatsApp admin bot) there is no admin, and these routes then insert admin_id NULL (today that insert
-- fails on the NOT NULL and the action goes unaudited; it is best-effort and only logged):
--   app/api/admin/set-admin/route.ts                     admin_id: adminUserId || null
--   app/api/admin/remove-admin/route.ts                  admin_id: adminUserId || null
--   app/api/admin/settings/network-prefixes/route.ts     admin_id: adminId || null
--   app/api/admin/whatsapp/cashback-visibility/route.ts  admin_id: userId (undefined under the bypass)
--   app/api/admin/ussd-hubtel/config/route.ts            admin_id: userId (undefined under the bypass)
-- With the column nullable those actions are recorded, with admin_id NULL meaning "no signed-in admin (CRON
-- bypass)". Every other writer (writeAudit, the admin users routes, 0142, 0146, refunds, hubtel-cs, sms
-- moderation, ussd-hubtel resolve) always supplies an admin id or skips the row.
--
-- Drops the constraints by their real names (IF EXISTS), and also any other foreign key on these two columns
-- (a database where they were renamed or duplicated). Idempotent. One transaction. No data changes.
-- Apply after 0069. Safe before or after the app deploy.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_admin_id_fkey;
ALTER TABLE public.admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_target_user_id_fkey;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.admin_audit_log'::regclass
      AND c.contype = 'f'
      AND EXISTS (
        SELECT 1 FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE a.attname IN ('admin_id', 'target_user_id')
      )
  LOOP
    EXECUTE format('ALTER TABLE public.admin_audit_log DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.admin_audit_log ALTER COLUMN admin_id DROP NOT NULL;

COMMIT;

-- Verify after apply (expect no rows; and attnotnull false):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.admin_audit_log'::regclass AND contype = 'f';
--   SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.admin_audit_log'::regclass AND attname = 'admin_id';
