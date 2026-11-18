-- 0184_roles_foundation.sql
--
-- Custom roles, Phase 1 Task 1: a roles table, per-role package prices, a two-way mirror between packages.dealer_price and
-- the dealer role's rows, and a users.role foreign key. ADDITIVE; service-role only. NOT applied by the implementing agent.
-- One transaction. Idempotent (re-runnable). Nothing reads the new tables yet.
--
--   roles(id, slug UNIQUE, name, description, badge_color, icon, rank, is_system, is_public, fallback_role_id, theme, limits, archived_at, ...)
--   role_package_prices(role_id, package_id, price > 0, PK (role_id, package_id))
--
-- Seed: user (rank 0), dealer (rank 10, public, fallback user), sub_agent (rank NULL), admin (rank NULL); all is_system.
-- roles_protect_system refuses deleting a system role, changing its slug / is_system, or archiving it.
--
-- Mirror (so every existing reader of packages.dealer_price keeps working unchanged). Neither trigger uses pg_trigger_depth():
-- each writes the other side ONLY when the value differs from what is already there, so the pair converges and stops.
--   packages_dealer_price_mirror: dealer_price > 0 (at 2dp) -> upsert dealer row if missing/different; else delete dealer row if present.
--   role_package_prices_dealer_mirror (dealer rows only): set packages.dealer_price = price if different; on delete set it NULL if it was > 0.
-- The dealer backfill runs BEFORE the triggers exist.
--
-- users.role gets FOREIGN KEY -> roles(slug) (NULL role stays allowed), added NOT VALID then VALIDATEd.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.roles');                                    -- NULL
--   SELECT DISTINCT role FROM public.users;                                -- subset of {user, dealer, sub_agent, admin, NULL}
--   SELECT count(*) FROM public.packages WHERE dealer_price > 0;           -- record N; role_package_prices must hold N dealer rows after
--
-- Dry run: migrations/0184_roles_foundation.selftest.sql (build the run string by code, as lib/roles/migration-0184.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ============ roles ============
CREATE TABLE IF NOT EXISTS public.roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{1,31}$'),
  name             text NOT NULL,
  description      text,
  badge_color      text,
  icon             text,
  rank             int,
  is_system        boolean NOT NULL DEFAULT false,
  is_public        boolean NOT NULL DEFAULT false,
  fallback_role_id uuid REFERENCES public.roles(id),
  theme            jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits           jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_rank_unique
  ON public.roles (rank) WHERE rank IS NOT NULL AND archived_at IS NULL;

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO service_role;

INSERT INTO public.roles (slug, name, rank, is_system) VALUES ('user', 'User', 0, true)
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.roles (slug, name, rank, is_system, is_public, fallback_role_id)
SELECT 'dealer', 'Dealer', 10, true, true, (SELECT id FROM public.roles WHERE slug = 'user')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.roles (slug, name, rank, is_system) VALUES ('sub_agent', 'Sub-agent', NULL, true)
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.roles (slug, name, rank, is_system) VALUES ('admin', 'Admin', NULL, true)
ON CONFLICT (slug) DO NOTHING;

CREATE OR REPLACE FUNCTION public.roles_protect_system() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn_protect$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN RAISE EXCEPTION 'system role % cannot be deleted', OLD.slug; END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_system THEN
    IF NEW.slug IS DISTINCT FROM OLD.slug THEN RAISE EXCEPTION 'system role % slug cannot change', OLD.slug; END IF;
    IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN RAISE EXCEPTION 'system role % is_system cannot change', OLD.slug; END IF;
    IF NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'system role % cannot be archived', OLD.slug; END IF;
  END IF;
  RETURN NEW;
END $fn_protect$;

DROP TRIGGER IF EXISTS roles_protect_system ON public.roles;
CREATE TRIGGER roles_protect_system BEFORE UPDATE OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.roles_protect_system();

-- ============ role_package_prices ============
CREATE TABLE IF NOT EXISTS public.role_package_prices (
  role_id    uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES public.packages(id) ON DELETE CASCADE,
  price      numeric(10,2) NOT NULL CHECK (price > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, package_id)
);

ALTER TABLE public.role_package_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_package_prices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_package_prices TO service_role;

-- Backfill (BEFORE the mirror triggers): one dealer row per package with a dealer price.
INSERT INTO public.role_package_prices (role_id, package_id, price)
SELECT r.id, p.id, round(p.dealer_price, 2)
  FROM public.packages p
 CROSS JOIN (SELECT id FROM public.roles WHERE slug = 'dealer') r
 WHERE round(p.dealer_price, 2) > 0
ON CONFLICT (role_id, package_id) DO NOTHING;

-- ============ two-way mirror (value convergence, no pg_trigger_depth) ============
CREATE OR REPLACE FUNCTION public.packages_dealer_price_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn_pkg$
DECLARE
  v_dealer uuid;
BEGIN
  SELECT id INTO v_dealer FROM public.roles WHERE slug = 'dealer';
  IF v_dealer IS NULL THEN RETURN NEW; END IF;
  IF NEW.dealer_price IS NOT NULL AND round(NEW.dealer_price, 2) > 0 THEN
    INSERT INTO public.role_package_prices (role_id, package_id, price)
    VALUES (v_dealer, NEW.id, round(NEW.dealer_price, 2))
    ON CONFLICT (role_id, package_id)
    DO UPDATE SET price = EXCLUDED.price, updated_at = now()
    WHERE public.role_package_prices.price IS DISTINCT FROM EXCLUDED.price;
  ELSE
    DELETE FROM public.role_package_prices WHERE role_id = v_dealer AND package_id = NEW.id;
  END IF;
  RETURN NEW;
END $fn_pkg$;

CREATE OR REPLACE FUNCTION public.role_package_prices_dealer_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn_rpp$
DECLARE
  v_dealer uuid;
BEGIN
  SELECT id INTO v_dealer FROM public.roles WHERE slug = 'dealer';
  IF v_dealer IS NULL THEN RETURN NULL; END IF;
  -- Old side (DELETE, or an UPDATE that moved the row off dealer / onto another package): clear it if still set.
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD.role_id = v_dealer
     AND (TG_OP = 'DELETE' OR NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.package_id IS DISTINCT FROM OLD.package_id) THEN
    UPDATE public.packages SET dealer_price = NULL WHERE id = OLD.package_id AND dealer_price > 0;
  END IF;
  -- New side.
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role_id = v_dealer THEN
    UPDATE public.packages SET dealer_price = NEW.price
     WHERE id = NEW.package_id AND dealer_price IS DISTINCT FROM NEW.price;
  END IF;
  RETURN NULL;
END $fn_rpp$;

-- The mirror functions run as their owner (SECURITY DEFINER): roles / role_package_prices are revoked from anon and
-- authenticated, yet any role that may write packages.dealer_price must still fire them. Firing a trigger needs no EXECUTE.
REVOKE EXECUTE ON FUNCTION public.packages_dealer_price_mirror() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.role_package_prices_dealer_mirror() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS packages_dealer_price_mirror ON public.packages;
CREATE TRIGGER packages_dealer_price_mirror AFTER INSERT OR UPDATE OF dealer_price ON public.packages
  FOR EACH ROW EXECUTE FUNCTION public.packages_dealer_price_mirror();

DROP TRIGGER IF EXISTS role_package_prices_dealer_mirror ON public.role_package_prices;
CREATE TRIGGER role_package_prices_dealer_mirror AFTER INSERT OR UPDATE OR DELETE ON public.role_package_prices
  FOR EACH ROW EXECUTE FUNCTION public.role_package_prices_dealer_mirror();

-- ============ users.role -> roles(slug) ============
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_fk' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES public.roles(slug) NOT VALID;
  END IF;
END $fk$;
ALTER TABLE public.users VALIDATE CONSTRAINT users_role_fk;

COMMIT;
