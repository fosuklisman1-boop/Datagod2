-- Create network-logos storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('network-logos', 'network-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Set up bucket policies for public read access
CREATE POLICY "Public Access" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'network-logos');

CREATE POLICY "Authenticated Upload" ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'network-logos' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated Update" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'network-logos' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated Delete" ON storage.objects
  FOR DELETE
  USING (bucket_id = 'network-logos' AND auth.role() = 'authenticated');
