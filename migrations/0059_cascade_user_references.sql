-- 0059_cascade_user_references.sql
--
-- Make deleting a user cascade cleanly through its ENTIRE data tree.
--
-- The problem: deleting a user cascades users -> shop_orders -> shop_profits ->
-- ... and ANY foreign key along that path left at NO ACTION / RESTRICT aborts the
-- whole delete (transactional) with ERROR 23503. The gaps are spread across many
-- levels, so a flat one-table sweep isn't enough.
--
-- The fix: walk the cascade tree. `reached` = users (public + auth) plus every
-- table transitively reachable by following FK parent->child edges. Then give an
-- explicit ON DELETE to every public-schema FK whose PARENT is in that tree and is
-- still NO ACTION / RESTRICT:
--   - nullable FK column -> SET NULL  (keep the row, drop the departed user/order)
--   - NOT NULL FK column -> CASCADE   (row is meaningless without its parent)
--
-- Precision matters: it only rebinds FKs in the user-deletion path, so unrelated
-- constraints (e.g. order -> package) keep their RESTRICT semantics. The
-- ns.nspname='public' guard ensures auth's internal FKs are never touched.
-- Idempotent (a re-run finds no NO ACTION / RESTRICT left in the tree).

DO $$
DECLARE
  r           RECORD;
  fk_cols     text;
  ref_cols    text;
  col_notnull boolean;     -- NOT 'notnull': collides with the SQL NOTNULL token
  del_action  text;
BEGIN
  FOR r IN
    WITH RECURSIVE reached AS (
      SELECT 'public.users'::regclass::oid AS tbl
      UNION
      SELECT 'auth.users'::regclass::oid
      UNION
      SELECT c.conrelid                         -- child becomes reachable...
      FROM pg_constraint c
      JOIN reached rt ON c.confrelid = rt.tbl    -- ...when its parent is reached
      WHERE c.contype = 'f'
    )
    SELECT c.conname,
           c.conrelid            AS child_oid,
           c.conrelid::regclass  AS child_tbl,
           c.confrelid           AS parent_oid,
           c.confrelid::regclass AS parent_tbl,
           c.conkey, c.confkey
    FROM pg_constraint c
    JOIN pg_class     cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE c.contype = 'f'
      AND c.confrelid IN (SELECT tbl FROM reached)   -- FK is an edge in the tree
      AND c.confdeltype IN ('a', 'r')                -- NO ACTION / RESTRICT = blocker
      AND ns.nspname = 'public'                      -- our tables only
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
-- VERIFY — no NO ACTION / RESTRICT should remain anywhere in the user-delete tree:
--   WITH RECURSIVE reached AS (
--     SELECT 'public.users'::regclass::oid AS tbl
--     UNION SELECT 'auth.users'::regclass::oid
--     UNION SELECT c.conrelid FROM pg_constraint c JOIN reached rt ON c.confrelid=rt.tbl WHERE c.contype='f'
--   )
--   SELECT c.conrelid::regclass AS child, c.confrelid::regclass AS parent, c.conname,
--          CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
--               WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' END AS on_delete
--   FROM pg_constraint c
--   JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
--   WHERE c.contype='f' AND c.confrelid IN (SELECT tbl FROM reached) AND ns.nspname='public'
--   ORDER BY on_delete, child;
-- ───────────────────────────────────────────────────────────────────────────
