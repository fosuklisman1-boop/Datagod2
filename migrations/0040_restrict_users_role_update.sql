-- Prevent authenticated users from updating their own role column
--
-- Problem: The "Users can update own profile" policy allows any authenticated
-- user to UPDATE any column on their own row, including `role`.
-- A hacker with a valid session could call:
--   supabase.from('users').update({ role: 'admin' }).eq('id', myUserId)
--
-- Fix: Replace the open UPDATE policy with one that explicitly excludes
-- role changes. We use a WITH CHECK that verifies role stays unchanged.

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM public.users WHERE id = auth.uid())
  );
