-- Allow text/plain in the admin-uploads bucket.
--
-- The Results Check WhatsApp delivery uses the approved "results_check_delivery"
-- template, which has a DOCUMENT header and therefore REQUIRES a document on
-- every send. For text-only results (admin typed grades, no photo/PDF) we
-- generate a .txt summary and attach it (lib/results-checker-service.ts
-- uploadResultTextFile). The bucket's original allowed_mime_types
-- (20260609_create_admin_uploads_bucket.sql) didn't include text/plain, so that
-- upload would be rejected. Append it. Idempotent.
UPDATE storage.buckets
SET allowed_mime_types = array_append(allowed_mime_types, 'text/plain')
WHERE id = 'admin-uploads'
  AND NOT ('text/plain' = ANY(allowed_mime_types));
