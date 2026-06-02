-- 0059_cascade_user_references.sql
--
-- Make deleting a user cascade end-to-end. Two facts drive this:
--   (a) Some of our tables reference public.users, others reference auth.users
--       directly (e.g. shop_invites.accepted_by_user_id -> auth.users).
--   (b) Any such FK left at NO ACTION / RESTRICT blocks the whole delete
--       (transactional, all-or-nothing) -> ERROR 23503.
--
-- So we rebind EVERY foreign key whose CHILD table is in the public schema and
-- whose PARENT is either users table, giving each an explicit ON DELETE:
--   - nullable FK column -> SET NULL  (keep the row, drop the departed user)
--   - NOT NULL FK column -> CASCADE   (row is meaningless without the user)
--
-- CRITICAL: only rebinds FKs whose CHILD lives in `public` — it must NEVER touch
-- auth's own internal FKs (auth.identities/sessions/... -> auth.users). Only
-- touches NO ACTION / RESTRICT, so CASCADE/SET NULL FKs are left alone. Idempotent.

DO $$
DECLARE
  r           RECORD;
  fk_cols     text;
  ref_cols    text;
  col_notnull boolean;     -- NOT 'notnull': that collides with the SQL NOTNULL token
  del_action  text;
BEGIN
  FOR r IN
    SELECT c.conname,
           c.conrelid              AS child_oid,
           c.conrelid::regclass    AS child_tbl,
           c.confrelid             AS parent_oid,
           c.confrelid::regclass   AS parent_tbl,
           c.conkey, c.confkey
    FROM pg_constraint c
    JOIN pg_class     cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE c.confrelid IN ('public.users'::regclass, 'auth.users'::regclass)
      AND c.contype = 'f'
      AND c.confdeltype IN ('a', 'r')     -- NO ACTION / RESTRICT = the blockers
      AND ns.nspname = 'public'           -- our tables only; never auth-internal FKs
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord), bool_or(a.attnotnull)
      INTO fk_cols, col_notnull
    FROM unnest(r.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = r.child_oid AND a.attnum = k.attnum;

    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
      INTO ref_cols
    FROM unnest(r.confkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = r.parent_oid AND a.attnum = k.attnum;

    del_action := CASE WHEN col_notnull THEN 'CASCADE' ELSE 'SET NULL' END;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.child_tbl, r.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %s(%s) ON DELETE %s',
      r.child_tbl, r.conname, fk_cols, r.parent_tbl, ref_cols, del_action
    );
    RAISE NOTICE 'Rebound %.%  ->  %  ON DELETE %', r.child_tbl, r.conname, r.parent_tbl, del_action;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY — every public-schema FK to either users table should be CASCADE/SET NULL:
--   SELECT c.conrelid::regclass AS child, c.confrelid::regclass AS parent, c.conname,
--          CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
--               WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' END AS on_delete
--   FROM pg_constraint c
--   JOIN pg_class cl ON cl.oid = c.conrelid
--   JOIN pg_namespace ns ON ns.oid = cl.relnamespace
--   WHERE c.confrelid IN ('public.users'::regclass,'auth.users'::regclass)
--     AND c.contype='f' AND ns.nspname='public'
--   ORDER BY on_delete, child;
-- ───────────────────────────────────────────────────────────────────────────
