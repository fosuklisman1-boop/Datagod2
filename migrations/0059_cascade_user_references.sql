-- 0059_cascade_user_references.sql
--
-- After binding public.users.id -> auth.users(id) ON DELETE CASCADE, deleting an
-- auth user cascades into public.users — but any OTHER table that references
-- public.users WITHOUT a delete action (NO ACTION / RESTRICT) blocks the whole
-- delete (transactional, all-or-nothing). e.g.:
--   ERROR 23503: ... violates FK "shop_invites_accepted_by_user_id_fkey"
--
-- This gives every such FK an explicit ON DELETE so the cascade runs end-to-end:
--   - nullable FK column -> SET NULL  (keep the row, just drop the departed user)
--   - NOT NULL FK column -> CASCADE   (row is meaningless without the user)
--
-- Only rebinds FKs that currently have NO ACTION / RESTRICT, so it leaves FKs
-- already set to CASCADE/SET NULL untouched. Idempotent (a second run finds no
-- blockers). The re-added FK re-validates existing rows, but they're already valid
-- (the FK existed), so it's fast at this app's table sizes.

DO $$
DECLARE
  r        RECORD;
  fk_cols  text;
  ref_cols text;
  notnull  boolean;
  action   text;
BEGIN
  FOR r IN
    SELECT conname, conrelid, conrelid::regclass AS tbl, conkey, confkey
    FROM pg_constraint
    WHERE confrelid = 'public.users'::regclass
      AND contype = 'f'
      AND confdeltype IN ('a', 'r')          -- NO ACTION / RESTRICT = the blockers
  LOOP
    -- local FK column(s) + whether ANY of them is NOT NULL (=> must CASCADE)
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord), bool_or(a.attnotnull)
      INTO fk_cols, notnull
    FROM unnest(r.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = r.conrelid AND a.attnum = k.attnum;

    -- referenced column(s) on public.users (normally just id)
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
      INTO ref_cols
    FROM unnest(r.confkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = 'public.users'::regclass AND a.attnum = k.attnum;

    action := CASE WHEN notnull THEN 'CASCADE' ELSE 'SET NULL' END;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES public.users(%s) ON DELETE %s',
      r.tbl, r.conname, fk_cols, ref_cols, action
    );
    RAISE NOTICE 'Rebound %.%  ->  ON DELETE %', r.tbl, r.conname, action;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY (should show ONLY cascade / set null now — no NO ACTION / RESTRICT):
--   SELECT conrelid::regclass AS referencing_table, conname,
--          CASE confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
--               WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' END AS on_delete
--   FROM pg_constraint
--   WHERE confrelid = 'public.users'::regclass AND contype = 'f'
--   ORDER BY on_delete, referencing_table;
-- ───────────────────────────────────────────────────────────────────────────
