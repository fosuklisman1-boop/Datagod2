-- 20260615_fix_admin_uploads_storage_policies.sql
--
-- SECURITY FIX (MEDIUM) — admin-uploads bucket writable/deletable by ANY authenticated user.
--
-- ROOT CAUSE
-- migrations/20260609_create_admin_uploads_bucket.sql created the storage.objects
-- policies "Admins can upload/update/delete admin-uploads" as TO authenticated
-- USING/WITH CHECK (bucket_id = 'admin-uploads') with NO owner or admin-role
-- check. Despite the names, ANY logged-in user can upload, OVERWRITE, or DELETE
-- ANY object in the bucket — which stores customers' exam-results media (PII,
-- and text/plain result files). Impact: tamper with / delete delivered results,
-- or host arbitrary <=10MB files under a company-controlled public URL.
--
-- LEGIT WRITERS
--  - Admin web dashboard uploads with the ADMIN's JWT (authenticated) directly to
--    the storage REST API (app/admin/results-check-requests/page.tsx).
--  - Server flows (app/api/whatsapp/webhook, lib/results-checker-service
--    uploadResultTextFile) upload via the SERVICE-ROLE client, which bypasses RLS.
-- So we scope the write policies to ADMINS (keeps the dashboard working; blocks
-- ordinary users). Service-role is unaffected.
--
-- READ: the public-read policy is intentionally retained — WhatsApp/Meta fetches
-- the media by URL, object paths embed unguessable UUIDs, and the table that
-- previously leaked those URLs wholesale (results_check_requests) is now locked to
-- service_role (20260615_fix_broken_rls_sensitive_tables.sql). For stronger
-- defense-in-depth, a follow-up can make the bucket private and switch delivery to
-- short-lived signed URLs (createSignedUrl at send time).

BEGIN;

DROP POLICY IF EXISTS "Admins can upload to admin-uploads" ON storage.objects;
CREATE POLICY "Admins can upload to admin-uploads"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'admin-uploads'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );

DROP POLICY IF EXISTS "Admins can update admin-uploads" ON storage.objects;
CREATE POLICY "Admins can update admin-uploads"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'admin-uploads'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );

DROP POLICY IF EXISTS "Admins can delete admin-uploads" ON storage.objects;
CREATE POLICY "Admins can delete admin-uploads"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'admin-uploads'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );

COMMIT;

-- Verify: the three write policies on storage.objects for admin-uploads now
-- require the admin-role EXISTS check (non-admins can no longer write/delete):
--   SELECT policyname, cmd, qual, with_check FROM pg_policies
--    WHERE schemaname='storage' AND tablename='objects'
--      AND policyname ILIKE '%admin-uploads%';
