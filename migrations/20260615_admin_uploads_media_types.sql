-- Broaden the admin-uploads bucket so inbound WhatsApp media actually stores.
--
-- Service-role uploads do NOT bypass a bucket's MIME allowlist (verified: an
-- audio/ogg upload returned 415 invalid_mime_type), so customer voice notes
-- (audio/ogg), audio files and office documents were rejected at storage and only
-- showed a "couldn't be loaded" placeholder in the admin inbox thread. Add the full
-- WhatsApp-supported media set and raise the size limit 10MB -> 20MB (WhatsApp
-- videos can be ~16MB). The list is deliberately curated (no html/svg/executables
-- in a public bucket).
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg','image/png','image/webp','image/gif',
  'video/mp4','video/3gpp','video/quicktime',
  'audio/aac','audio/amr','audio/mpeg','audio/mp4','audio/ogg','audio/opus',
  'application/pdf','text/plain',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'
],
    file_size_limit = 20971520
WHERE id = 'admin-uploads';
