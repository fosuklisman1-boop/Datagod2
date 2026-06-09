-- Create the admin-uploads storage bucket for results check media attachments

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'admin-uploads',
  'admin-uploads',
  true,
  10485760,  -- 10 MB per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'video/mp4', 'video/quicktime']
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users (admins) to upload
CREATE POLICY "Admins can upload to admin-uploads"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'admin-uploads');

-- Allow public read access (so WhatsApp can fetch the media URL)
CREATE POLICY "Public read access for admin-uploads"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'admin-uploads');

-- Allow authenticated users to update/delete their uploads
CREATE POLICY "Admins can update admin-uploads"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'admin-uploads');

CREATE POLICY "Admins can delete admin-uploads"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'admin-uploads');
