-- 0151_admin_audit_log_fk_set_null.sql
--
-- Lets a user (or an admin) be deleted while admin_audit_log rows point at them.
--
-- 0069 created admin_audit_log with
--   admin_id       uuid NOT NULL REFERENCES auth.users(id)     -- admin_audit_log_admin_id_fkey
--   target_user_id uuid          REFERENCES auth.users(id)     -- admin_audit_log_target_user_id_fkey
-- both with the default ON DELETE NO ACTION (no later migration touches them). So deleting any auth user who
-- was ever the target (or the actor) of an audited admin action fails with a foreign key violation. With bulk
-- notifications writing one audit row per user notified, that is most users: POST /api/admin/remove-user then
-- deletes the profile, wallet, orders and shops, and only fails at the last step (auth.admin.deleteUser),
-- leaving a half-deleted account.
--
-- After this migration both foreign keys are ON DELETE SET NULL: the audit trail is kept (who did what, when,
-- and the old/new values), and a deleted user's or admin's id becomes NULL in it. admin_id therefore loses its
-- NOT NULL. The app always writes admin_id (the routes refuse the CRON bypass for audited writes), so new rows
-- still carry it; only rows of deleted admins become NULL.
--
-- Constraints are found by column (any FK on admin_audit_log.admin_id / target_user_id), not by name, so a
-- database where they carry other names, or where a duplicate was added, ends with exactly one FK per column,
-- named admin_audit_log_admin_id_fkey and admin_audit_log_target_user_id_fkey.
-- Idempotent: re-running drops and re-adds the same two constraints. One transaction. No data changes.
-- The new FKs are added NOT VALID and then validated, so the long part (checking existing rows) does not block
-- writes to admin_audit_log or auth.users; lock_timeout keeps the short ALTERs from queueing behind traffic.
--
-- Also relevant to deleting users: admin_user_notes.user_id and admin_user_tags.user_id (0149) are
-- ON DELETE CASCADE, and their author_id / created_by are ON DELETE SET NULL.
--
-- Apply after 0069. Safe to apply before or after the app deploy.

BEGIN;
SET LOCAL lock_timeout = '5s';

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

ALTER TABLE public.admin_audit_log
  ADD CONSTRAINT admin_audit_log_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.admin_audit_log
  ADD CONSTRAINT admin_audit_log_target_user_id_fkey
  FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.admin_audit_log VALIDATE CONSTRAINT admin_audit_log_admin_id_fkey;
ALTER TABLE public.admin_audit_log VALIDATE CONSTRAINT admin_audit_log_target_user_id_fkey;

COMMIT;

-- Verify after apply (expect two rows, confdeltype 'n', convalidated true):
--   SELECT conname, confdeltype, convalidated FROM pg_constraint
--   WHERE conrelid = 'public.admin_audit_log'::regclass AND contype = 'f';
