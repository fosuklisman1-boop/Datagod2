-- Fix: infinite recursion in "Users can update own profile" policy
--
-- Root cause: the WITH CHECK clause in migration 0040 contains a subquery that
-- reads from public.users, which re-enters RLS evaluation for the same table,
-- causing PostgreSQL to detect infinite recursion.
--
-- Fix: wrap the role lookup in a SECURITY DEFINER function so it bypasses RLS,
-- breaking the recursion cycle.

CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM public.users WHERE id = auth.uid()
$$;

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (
    id = (SELECT auth.uid())
    AND role = public.get_current_user_role()
  );
