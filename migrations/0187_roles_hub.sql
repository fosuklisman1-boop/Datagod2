-- 0187_roles_hub.sql
--
-- Custom roles, Phase 3 Task 1: the admin roles hub back end. ADDITIVE; service-role only. NOT applied by the implementing
-- agent. One transaction. Idempotent (CREATE ... IF NOT EXISTS / OR REPLACE / ON CONFLICT; re-runnable). Nothing reads it yet.
--
--   role_permissions(role_id -> roles ON DELETE CASCADE, capability, PK (role_id, capability))
--   role_audit_log(id bigserial, actor_id, role_id -> roles, action, before, after, reason, loss_override, created_at)
--       append-only: a BEFORE UPDATE OR DELETE trigger (and BEFORE TRUNCATE) raises; service_role holds SELECT + INSERT only.
--   packages.cost_price numeric(10,2) NULL CHECK (>= 0): supplier cost, used only to refuse below-cost role prices.
--   Seeds: user and dealer receive all 14 capability keys; theme '{"skin":"dealer"}' / '{"skin":"default"}' where theme = '{}'.
--
-- Audit of prices: three statement-level AFTER triggers (INSERT / UPDATE / DELETE, transition tables) on role_package_prices
-- write one role_audit_log row per (statement, role_id). With the transaction-local setting app.role_audit present (set by
-- admin_role_set_prices) the action is 'prices' with its actor / reason / loss_override; without it (for example the dealer
-- mirror from UPDATE packages SET dealer_price) the action is 'price_external' and actor_id is NULL. The existing 0184 mirror
-- triggers are not touched. A batch that both inserts and updates rows is two statements, so it writes two audit rows.
--
-- Write functions (all SECURITY DEFINER, search_path = public, pg_temp; EXECUTE revoked from PUBLIC / anon / authenticated,
-- granted to service_role). Each refuses a NULL actor or a reason shorter than 3 characters, locks the target roles row
-- FOR UPDATE and writes an audit row:
--   admin_role_create, admin_role_update, admin_role_swap_rank, admin_role_archive, admin_role_set_prices,
--   admin_role_set_rates, admin_role_set_permissions, plus the read-only admin_role_stats().
--
-- Race guards: admin_role_swap_rank takes the expected ranks (p_expected_a/b), serializes on an advisory lock and raises
-- 'ranks changed, reload' on a stale pick or a live role in the gap. Triggers users_role_not_archived_ins/_upd (BEFORE INSERT /
-- BEFORE UPDATE OF role on public.users, the update only when role changes) raise 'role is archived' for an archived slug.
-- Manual undo (if ever needed): DROP TRIGGER users_role_not_archived_ins/_upd ON public.users; DROP FUNCTION users_role_not_archived().
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT slug, rank, is_system, archived_at FROM public.roles ORDER BY rank NULLS LAST;   -- record the census (0184 seeds + any custom)
--   SELECT count(*) FROM public.role_package_prices;                                        -- record N; unchanged after applying
--   SELECT to_regclass('public.role_permissions'), to_regclass('public.role_audit_log');    -- NULL, NULL
--   SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='packages' AND column_name='cost_price';  -- no rows
--   SELECT to_regclass('public.role_service_rates');                                        -- NOT NULL (0186 applied)
--   -- Apply in a quiet window: ALTER TABLE packages and CREATE TRIGGER on role_package_prices take short exclusive locks.
--   -- Do NOT insert any non-system roles row until Phase 2 is complete (lib/roles/flags.ts).
--
-- Dry run: migrations/0187_roles_hub.selftest.sql (build the run string by code, as lib/roles/migration-0187.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ============ packages.cost_price ============
ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS cost_price numeric(10,2) NULL CHECK (cost_price IS NULL OR cost_price >= 0);

-- ============ role_permissions ============
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id    uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability ~ '^[a-z_]+(\.[a-z_]+)*$'),
  PRIMARY KEY (role_id, capability)
);
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO service_role;

-- ============ role_audit_log ============
CREATE TABLE IF NOT EXISTS public.role_audit_log (
  id            bigserial PRIMARY KEY,
  actor_id      uuid NULL,
  role_id       uuid NOT NULL REFERENCES public.roles(id),
  action        text NOT NULL,
  before        jsonb,
  after         jsonb,
  reason        text,
  loss_override boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS role_audit_log_role_created_idx ON public.role_audit_log (role_id, created_at DESC);
ALTER TABLE public.role_audit_log ENABLE ROW LEVEL SECURITY;
-- service_role is revoked too: Supabase default privileges grant it everything, and this log is SELECT + INSERT only.
REVOKE ALL ON public.role_audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.role_audit_log TO service_role;
REVOKE ALL ON SEQUENCE public.role_audit_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.role_audit_log_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.role_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn_append$
BEGIN
  RAISE EXCEPTION 'role_audit_log is append-only';
END $fn_append$;

DROP TRIGGER IF EXISTS role_audit_log_append_only ON public.role_audit_log;
CREATE TRIGGER role_audit_log_append_only BEFORE UPDATE OR DELETE ON public.role_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.role_audit_log_append_only();
DROP TRIGGER IF EXISTS role_audit_log_no_truncate ON public.role_audit_log;
CREATE TRIGGER role_audit_log_no_truncate BEFORE TRUNCATE ON public.role_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.role_audit_log_append_only();

-- ============ seeds ============
INSERT INTO public.role_permissions (role_id, capability)
SELECT r.id, c.cap
  FROM public.roles r
 CROSS JOIN unnest(ARRAY[
   'buy.data', 'buy.airtime', 'buy.afa', 'buy.bills', 'buy.results',
   'shop.storefront', 'shop.subagents', 'shop.bots', 'shop.sms', 'shop.text_orders',
   'account.wallet', 'account.api', 'account.leaderboard', 'account.upgrade'
 ]) AS c(cap)
 WHERE r.slug IN ('user', 'dealer')
ON CONFLICT (role_id, capability) DO NOTHING;

UPDATE public.roles SET theme = '{"skin":"dealer"}'::jsonb  WHERE slug = 'dealer' AND theme = '{}'::jsonb;
UPDATE public.roles SET theme = '{"skin":"default"}'::jsonb WHERE slug = 'user'   AND theme = '{}'::jsonb;

-- ============ price audit (statement-level, transition tables) ============
CREATE OR REPLACE FUNCTION public.role_package_prices_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_audit$
DECLARE
  v_raw    text;
  v_ctx    jsonb;
  v_actor  uuid;
  v_reason text;
  v_loss   boolean := false;
  v_action text;
BEGIN
  v_raw := nullif(current_setting('app.role_audit', true), '');
  IF v_raw IS NOT NULL THEN
    BEGIN
      v_ctx := v_raw::jsonb;
      v_actor := nullif(v_ctx->>'actor', '')::uuid;
      v_reason := v_ctx->>'reason';
      v_loss := coalesce((v_ctx->>'loss_override')::boolean, false);
    EXCEPTION WHEN others THEN
      v_ctx := NULL; v_actor := NULL; v_reason := NULL; v_loss := false;
    END;
  END IF;
  v_action := CASE WHEN v_ctx IS NULL THEN 'price_external' ELSE 'prices' END;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason, loss_override)
    SELECT v_actor, n.role_id, v_action, '[]'::jsonb,
           jsonb_agg(jsonb_build_object('package_id', n.package_id, 'price', n.price) ORDER BY n.package_id),
           v_reason, v_loss
      FROM new_rows n GROUP BY n.role_id;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason, loss_override)
    SELECT v_actor, o.role_id, v_action,
           jsonb_agg(jsonb_build_object('package_id', o.package_id, 'price', o.price) ORDER BY o.package_id),
           '[]'::jsonb, v_reason, v_loss
      FROM old_rows o GROUP BY o.role_id;
  ELSE
    INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason, loss_override)
    SELECT v_actor, coalesce(b.role_id, a.role_id), v_action,
           coalesce(b.rws, '[]'::jsonb), coalesce(a.rws, '[]'::jsonb), v_reason, v_loss
      FROM (SELECT o.role_id, jsonb_agg(jsonb_build_object('package_id', o.package_id, 'price', o.price) ORDER BY o.package_id) AS rws
              FROM old_rows o GROUP BY o.role_id) b
      FULL JOIN (SELECT n.role_id, jsonb_agg(jsonb_build_object('package_id', n.package_id, 'price', n.price) ORDER BY n.package_id) AS rws
                   FROM new_rows n GROUP BY n.role_id) a ON a.role_id = b.role_id;
  END IF;
  RETURN NULL;
END $fn_audit$;

REVOKE EXECUTE ON FUNCTION public.role_package_prices_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS role_package_prices_audit_ins ON public.role_package_prices;
CREATE TRIGGER role_package_prices_audit_ins AFTER INSERT ON public.role_package_prices
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.role_package_prices_audit();
DROP TRIGGER IF EXISTS role_package_prices_audit_upd ON public.role_package_prices;
CREATE TRIGGER role_package_prices_audit_upd AFTER UPDATE ON public.role_package_prices
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.role_package_prices_audit();
DROP TRIGGER IF EXISTS role_package_prices_audit_del ON public.role_package_prices;
CREATE TRIGGER role_package_prices_audit_del AFTER DELETE ON public.role_package_prices
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.role_package_prices_audit();

-- ============ write functions ============
-- Shared argument check: a named actor and a reason of at least 3 characters.
CREATE OR REPLACE FUNCTION public.roles_hub_guard(p_actor uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_guard$
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'actor required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'reason required (min 3 characters)'; END IF;
END $fn_guard$;

CREATE OR REPLACE FUNCTION public.admin_role_create(
  p_actor uuid, p_reason text, p_slug text, p_name text, p_rank int, p_clone_from uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_create$
DECLARE
  v_src    public.roles%ROWTYPE;
  v_perm   uuid;
  v_new    uuid;
  v_theme  jsonb := '{"skin":"default"}'::jsonb;
  v_below  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  IF p_slug IS NULL OR p_slug IN ('user', 'dealer', 'sub_agent', 'admin')
     OR EXISTS (SELECT 1 FROM public.roles WHERE slug = p_slug AND is_system) THEN
    RAISE EXCEPTION 'slug is reserved for a system role';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN RAISE EXCEPTION 'name required'; END IF;
  IF p_rank IS NULL OR p_rank <= 0 THEN RAISE EXCEPTION 'rank must be greater than 0'; END IF;
  IF EXISTS (SELECT 1 FROM public.roles WHERE slug = p_slug) THEN RAISE EXCEPTION 'slug already in use'; END IF;

  IF p_clone_from IS NOT NULL THEN
    SELECT * INTO v_src FROM public.roles WHERE id = p_clone_from FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'clone source not found'; END IF;
    IF v_src.slug IN ('admin', 'sub_agent') THEN RAISE EXCEPTION 'role % cannot be cloned', v_src.slug; END IF;
    IF v_src.archived_at IS NOT NULL THEN RAISE EXCEPTION 'clone source is archived'; END IF;
    v_perm := v_src.id;
    v_theme := v_src.theme;
  ELSE
    SELECT id INTO v_perm FROM public.roles WHERE slug = 'dealer' FOR UPDATE;
  END IF;

  -- Re-check the rank under a row lock; the partial unique index is the final backstop for a concurrent claim.
  PERFORM 1 FROM public.roles WHERE rank = p_rank AND archived_at IS NULL FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.roles WHERE rank = p_rank AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'rank % is already in use', p_rank;
  END IF;

  INSERT INTO public.roles (slug, name, rank, theme, description, badge_color, icon)
  VALUES (p_slug, trim(p_name), p_rank, v_theme, v_src.description, v_src.badge_color, v_src.icon)
  RETURNING id INTO v_new;

  INSERT INTO public.role_permissions (role_id, capability)
  SELECT v_new, capability FROM public.role_permissions WHERE role_id = v_perm;

  IF p_clone_from IS NOT NULL THEN
    PERFORM set_config('app.role_audit',
      json_build_object('actor', p_actor, 'reason', p_reason, 'loss_override', false)::text, true);
    INSERT INTO public.role_package_prices (role_id, package_id, price)
    SELECT v_new, package_id, price FROM public.role_package_prices WHERE role_id = p_clone_from;
    PERFORM set_config('app.role_audit', '', true);
    INSERT INTO public.role_service_rates (role_id, service_key, value)
    SELECT v_new, service_key, value FROM public.role_service_rates WHERE role_id = p_clone_from;
    -- Copied prices are not cost-checked (the source was); record any that now sit below cost.
    SELECT coalesce(jsonb_agg(r.package_id ORDER BY r.package_id), '[]'::jsonb) INTO v_below
      FROM public.role_package_prices r JOIN public.packages p ON p.id = r.package_id
     WHERE r.role_id = v_new AND p.cost_price IS NOT NULL AND r.price < p.cost_price;
  END IF;

  INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason)
  VALUES (p_actor, v_new, CASE WHEN p_clone_from IS NULL THEN 'create' ELSE 'clone' END, NULL,
          jsonb_build_object('slug', p_slug, 'name', trim(p_name), 'rank', p_rank, 'clone_from', p_clone_from)
            || CASE WHEN p_clone_from IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('below_cost', v_below) END,
          p_reason);
  RETURN v_new;
END $fn_create$;

CREATE OR REPLACE FUNCTION public.admin_role_update(
  p_actor uuid, p_reason text, p_role_id uuid, p_patch jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_update$
DECLARE
  v_role   public.roles%ROWTYPE;
  v_key    text;
  v_val    jsonb;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  IF v_role.slug = 'admin' THEN RAISE EXCEPTION 'the admin role cannot be edited'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'patch must be a non-empty object';
  END IF;
  FOR v_key, v_val IN SELECT k, x FROM jsonb_each(p_patch) AS e(k, x) LOOP
    IF v_key NOT IN ('name', 'description', 'badge_color', 'icon', 'theme') THEN
      RAISE EXCEPTION 'key % cannot be patched', v_key;
    END IF;
    IF v_key = 'theme' THEN
      IF jsonb_typeof(v_val) <> 'object' THEN RAISE EXCEPTION 'theme must be an object'; END IF;
    ELSIF v_key = 'name' THEN
      IF jsonb_typeof(v_val) <> 'string' OR length(trim(v_val #>> '{}')) = 0 THEN RAISE EXCEPTION 'name must be a non-empty string'; END IF;
    ELSIF jsonb_typeof(v_val) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION '% must be a string or null', v_key;
    END IF;
  END LOOP;

  v_before := jsonb_build_object('name', v_role.name, 'description', v_role.description,
    'badge_color', v_role.badge_color, 'icon', v_role.icon, 'theme', v_role.theme);
  UPDATE public.roles SET
    name        = CASE WHEN p_patch ? 'name' THEN trim(p_patch ->> 'name') ELSE name END,
    description = CASE WHEN p_patch ? 'description' THEN p_patch ->> 'description' ELSE description END,
    badge_color = CASE WHEN p_patch ? 'badge_color' THEN p_patch ->> 'badge_color' ELSE badge_color END,
    icon        = CASE WHEN p_patch ? 'icon' THEN p_patch ->> 'icon' ELSE icon END,
    theme       = CASE WHEN p_patch ? 'theme' THEN p_patch -> 'theme' ELSE theme END,
    updated_at  = now()
  WHERE id = p_role_id
  RETURNING jsonb_build_object('name', name, 'description', description, 'badge_color', badge_color, 'icon', icon, 'theme', theme)
  INTO v_after;
  INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason)
  VALUES (p_actor, p_role_id, 'update', v_before, v_after, p_reason);
END $fn_update$;

CREATE OR REPLACE FUNCTION public.admin_role_swap_rank(
  p_actor uuid, p_reason text, p_a uuid, p_b uuid, p_expected_a integer, p_expected_b integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_swap$
DECLARE
  v_a public.roles%ROWTYPE;
  v_b public.roles%ROWTYPE;
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN RAISE EXCEPTION 'two different roles required'; END IF;
  -- Serialize all rank swaps so a stale pick (double-click, concurrent admins) is re-verified against current ranks.
  PERFORM pg_advisory_xact_lock(hashtext('roles_rank'));
  -- Lock in a fixed order so two concurrent swaps cannot deadlock.
  PERFORM 1 FROM public.roles WHERE id IN (p_a, p_b) ORDER BY id FOR UPDATE;
  SELECT * INTO v_a FROM public.roles WHERE id = p_a;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  SELECT * INTO v_b FROM public.roles WHERE id = p_b;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  IF v_a.archived_at IS NOT NULL OR v_b.archived_at IS NOT NULL THEN RAISE EXCEPTION 'archived roles cannot be re-ranked'; END IF;
  IF v_a.rank IS NULL OR v_b.rank IS NULL THEN RAISE EXCEPTION 'both roles must be ranked'; END IF;
  IF v_a.slug = 'user' OR v_b.slug = 'user' THEN RAISE EXCEPTION 'the user role cannot be re-ranked'; END IF;
  IF p_expected_a IS DISTINCT FROM v_a.rank OR p_expected_b IS DISTINCT FROM v_b.rank THEN
    RAISE EXCEPTION 'ranks changed, reload';
  END IF;
  -- The two must still be neighbours: no live ranked role (other than user) strictly between them.
  IF EXISTS (SELECT 1 FROM public.roles r
              WHERE r.archived_at IS NULL AND r.rank IS NOT NULL AND r.slug <> 'user'
                AND r.rank > least(v_a.rank, v_b.rank) AND r.rank < greatest(v_a.rank, v_b.rank)) THEN
    RAISE EXCEPTION 'ranks changed, reload';
  END IF;

  UPDATE public.roles SET rank = -1, updated_at = now() WHERE id = p_a;
  UPDATE public.roles SET rank = v_a.rank, updated_at = now() WHERE id = p_b;
  UPDATE public.roles SET rank = v_b.rank, updated_at = now() WHERE id = p_a;

  INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason) VALUES
    (p_actor, p_a, 'rank', jsonb_build_object('rank', v_a.rank), jsonb_build_object('rank', v_b.rank, 'swapped_with', p_b), p_reason),
    (p_actor, p_b, 'rank', jsonb_build_object('rank', v_b.rank), jsonb_build_object('rank', v_a.rank, 'swapped_with', p_a), p_reason);
END $fn_swap$;

CREATE OR REPLACE FUNCTION public.admin_role_archive(
  p_actor uuid, p_reason text, p_role_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_archive$
DECLARE
  v_role public.roles%ROWTYPE;
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  IF v_role.is_system THEN RAISE EXCEPTION 'system role % cannot be archived', v_role.slug; END IF;
  IF v_role.archived_at IS NOT NULL THEN RAISE EXCEPTION 'role already archived'; END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE role = v_role.slug) THEN RAISE EXCEPTION 'role has members'; END IF;
  UPDATE public.roles SET archived_at = now(), updated_at = now() WHERE id = p_role_id;
  INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason)
  VALUES (p_actor, p_role_id, 'archive', jsonb_build_object('slug', v_role.slug, 'rank', v_role.rank), NULL, p_reason);
END $fn_archive$;

CREATE OR REPLACE FUNCTION public.admin_role_set_prices(
  p_actor uuid, p_reason text, p_role_id uuid, p_changes jsonb, p_loss_override boolean
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_prices$
DECLARE
  v_role  public.roles%ROWTYPE;
  v_item  jsonb;
  v_pkg   uuid;
  v_price numeric;
  v_cost  numeric;
  v_seen  uuid[] := ARRAY[]::uuid[];
  v_n     int := 0;
  v_rc    int;
  v_loss  boolean := coalesce(p_loss_override, false);
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  IF v_role.slug IN ('admin', 'sub_agent') THEN RAISE EXCEPTION 'role % has no price tier', v_role.slug; END IF;
  IF v_role.archived_at IS NOT NULL THEN RAISE EXCEPTION 'role is archived'; END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' THEN RAISE EXCEPTION 'changes must be an array'; END IF;

  -- Validate every entry before writing anything.
  FOR v_item IN SELECT x FROM jsonb_array_elements(p_changes) AS e(x) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN RAISE EXCEPTION 'each change must be an object'; END IF;
    v_pkg := (v_item ->> 'package_id')::uuid;
    IF v_pkg IS NULL THEN RAISE EXCEPTION 'package_id required'; END IF;
    IF v_pkg = ANY (v_seen) THEN RAISE EXCEPTION 'duplicate package_id %', v_pkg; END IF;
    v_seen := v_seen || v_pkg;
    SELECT cost_price INTO v_cost FROM public.packages WHERE id = v_pkg;
    IF NOT FOUND THEN RAISE EXCEPTION 'package % not found', v_pkg; END IF;
    -- Only an explicit JSON null deletes; a missing key (a typo) is refused.
    IF NOT (v_item ? 'price') THEN RAISE EXCEPTION 'price key required (use null to delete) for package %', v_pkg; END IF;
    IF jsonb_typeof(v_item -> 'price') <> 'null' THEN
      IF jsonb_typeof(v_item -> 'price') <> 'number' THEN RAISE EXCEPTION 'price must be a number or null'; END IF;
      v_price := round((v_item ->> 'price')::numeric, 2);
      IF v_price <= 0 THEN RAISE EXCEPTION 'price must be greater than 0'; END IF;
      IF v_cost IS NOT NULL AND v_price < v_cost AND NOT v_loss THEN
        RAISE EXCEPTION 'price % is below cost % for package % (loss override required)', v_price, v_cost, v_pkg;
      END IF;
    END IF;
  END LOOP;

  PERFORM set_config('app.role_audit',
    json_build_object('actor', p_actor, 'reason', p_reason, 'loss_override', v_loss)::text, true);

  INSERT INTO public.role_package_prices AS rpp (role_id, package_id, price)
  SELECT p_role_id, x.package_id, round(x.price, 2)
    FROM jsonb_to_recordset(p_changes) AS x(package_id uuid, price numeric)
   WHERE x.price IS NOT NULL
  ON CONFLICT (role_id, package_id)
  DO UPDATE SET price = EXCLUDED.price, updated_at = now() WHERE rpp.price IS DISTINCT FROM EXCLUDED.price;
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  v_n := v_n + v_rc;

  DELETE FROM public.role_package_prices
   WHERE role_id = p_role_id
     AND package_id IN (SELECT x.package_id FROM jsonb_to_recordset(p_changes) AS x(package_id uuid, price numeric) WHERE x.price IS NULL);
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  v_n := v_n + v_rc;

  PERFORM set_config('app.role_audit', '', true);
  RETURN v_n;
END $fn_prices$;

CREATE OR REPLACE FUNCTION public.admin_role_set_rates(
  p_actor uuid, p_reason text, p_role_id uuid, p_changes jsonb
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_rates$
DECLARE
  v_role   public.roles%ROWTYPE;
  v_item   jsonb;
  v_key    text;
  v_val    numeric;
  v_seen   text[] := ARRAY[]::text[];
  v_before jsonb;
  v_after  jsonb;
  v_n      int := 0;
  v_rc     int;
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  IF v_role.is_system THEN RAISE EXCEPTION 'system role % rates cannot be edited', v_role.slug; END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' THEN RAISE EXCEPTION 'changes must be an array'; END IF;

  FOR v_item IN SELECT x FROM jsonb_array_elements(p_changes) AS e(x) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN RAISE EXCEPTION 'each change must be an object'; END IF;
    v_key := v_item ->> 'service_key';
    IF v_key IS NULL OR v_key !~ '^[a-z_]+:[a-z0-9_]+$' THEN RAISE EXCEPTION 'bad service_key'; END IF;
    IF v_key = ANY (v_seen) THEN RAISE EXCEPTION 'duplicate service_key %', v_key; END IF;
    v_seen := v_seen || v_key;
    IF NOT (v_item ? 'value') THEN RAISE EXCEPTION 'value key required (use null to delete) for %', v_key; END IF;
    IF jsonb_typeof(v_item -> 'value') <> 'null' THEN
      IF jsonb_typeof(v_item -> 'value') <> 'number' THEN RAISE EXCEPTION 'value must be a number or null'; END IF;
      v_val := (v_item ->> 'value')::numeric;
      IF v_val < 0 OR v_val > 100 THEN RAISE EXCEPTION 'value must be between 0 and 100'; END IF;
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_object_agg(service_key, value), '{}'::jsonb) INTO v_before
    FROM public.role_service_rates WHERE role_id = p_role_id AND service_key = ANY (v_seen);

  INSERT INTO public.role_service_rates AS rsr (role_id, service_key, value)
  SELECT p_role_id, x.service_key, round(x.value, 2)
    FROM jsonb_to_recordset(p_changes) AS x(service_key text, value numeric)
   WHERE x.value IS NOT NULL
  ON CONFLICT (role_id, service_key)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE rsr.value IS DISTINCT FROM EXCLUDED.value;
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  v_n := v_n + v_rc;

  DELETE FROM public.role_service_rates
   WHERE role_id = p_role_id
     AND service_key IN (SELECT x.service_key FROM jsonb_to_recordset(p_changes) AS x(service_key text, value numeric) WHERE x.value IS NULL);
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  v_n := v_n + v_rc;

  SELECT coalesce(jsonb_object_agg(service_key, value), '{}'::jsonb) INTO v_after
    FROM public.role_service_rates WHERE role_id = p_role_id AND service_key = ANY (v_seen);
  INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason)
  VALUES (p_actor, p_role_id, 'rates', v_before, v_after, p_reason);
  RETURN v_n;
END $fn_rates$;

CREATE OR REPLACE FUNCTION public.admin_role_set_permissions(
  p_actor uuid, p_reason text, p_role_id uuid, p_caps text[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn_perms$
DECLARE
  v_role   public.roles%ROWTYPE;
  v_caps   text[];
  v_before jsonb;
BEGIN
  PERFORM public.roles_hub_guard(p_actor, p_reason);
  SELECT * INTO v_role FROM public.roles WHERE id = p_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'role not found'; END IF;
  IF v_role.slug IN ('admin', 'sub_agent') THEN RAISE EXCEPTION 'role % permissions cannot be edited', v_role.slug; END IF;
  IF p_caps IS NULL THEN RAISE EXCEPTION 'capabilities required'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_caps) AS c(cap) WHERE cap IS NULL OR cap !~ '^[a-z_]+(\.[a-z_]+)*$') THEN
    RAISE EXCEPTION 'invalid capability key';
  END IF;
  SELECT coalesce(array_agg(DISTINCT cap ORDER BY cap), ARRAY[]::text[]) INTO v_caps FROM unnest(p_caps) AS c(cap);

  SELECT coalesce(jsonb_agg(capability ORDER BY capability), '[]'::jsonb) INTO v_before
    FROM public.role_permissions WHERE role_id = p_role_id;
  DELETE FROM public.role_permissions WHERE role_id = p_role_id AND NOT (capability = ANY (v_caps));
  INSERT INTO public.role_permissions (role_id, capability)
  SELECT p_role_id, cap FROM unnest(v_caps) AS c(cap)
  ON CONFLICT (role_id, capability) DO NOTHING;
  INSERT INTO public.role_audit_log (actor_id, role_id, action, before, after, reason)
  VALUES (p_actor, p_role_id, 'permissions', v_before, to_jsonb(v_caps), p_reason);
END $fn_perms$;

CREATE OR REPLACE FUNCTION public.admin_role_stats() RETURNS TABLE (role_id uuid, member_count bigint, priced_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn_stats$
  SELECT r.id,
         (SELECT count(*) FROM public.users u WHERE u.role = r.slug),
         (SELECT count(*) FROM public.role_package_prices p WHERE p.role_id = r.id)
    FROM public.roles r;
$fn_stats$;

REVOKE ALL ON FUNCTION public.roles_hub_guard(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_create(uuid, text, text, text, int, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_update(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_swap_rank(uuid, text, uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_archive(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_set_prices(uuid, text, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_set_rates(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_set_permissions(uuid, text, uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_role_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_role_create(uuid, text, text, text, int, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_update(uuid, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_swap_rank(uuid, text, uuid, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_archive(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_set_prices(uuid, text, uuid, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_set_rates(uuid, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_set_permissions(uuid, text, uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_role_stats() TO service_role;

-- ============ no assignment to an archived role ============
-- FOR SHARE blocks behind an in-flight admin_role_archive (which holds FOR UPDATE on the role row), then sees archived_at,
-- so an assignment racing an archive either lands before the archive's member check or is refused here.
CREATE OR REPLACE FUNCTION public.users_role_not_archived() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn_ua$
BEGIN
  IF NEW.role IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.roles WHERE slug = NEW.role AND archived_at IS NOT NULL FOR SHARE;
  IF FOUND THEN RAISE EXCEPTION 'role is archived'; END IF;
  RETURN NEW;
END $fn_ua$;

DROP TRIGGER IF EXISTS users_role_not_archived_ins ON public.users;
CREATE TRIGGER users_role_not_archived_ins BEFORE INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_role_not_archived();
DROP TRIGGER IF EXISTS users_role_not_archived_upd ON public.users;
CREATE TRIGGER users_role_not_archived_upd BEFORE UPDATE OF role ON public.users
  FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role) EXECUTE FUNCTION public.users_role_not_archived();

COMMIT;
