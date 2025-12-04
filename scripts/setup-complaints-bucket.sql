-- Create complaint-evidence storage bucket
-- Run this SQL in your Supabase SQL Editor

-- Create the bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public)
VALUES ('complaint-evidence', 'complaint-evidence', true)
ON CONFLICT (id) DO NOTHING;

-- Set up storage policies for the complaint-evidence bucket

-- Allow authenticated users to upload their own complaint evidence
CREATE POLICY "Users can upload their own complaint evidence"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'complaint-evidence' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow authenticated users to read their own complaint evidence
CREATE POLICY "Users can view their own complaint evidence"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'complaint-evidence' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Allow admins to view all complaint evidence
CREATE POLICY "Admins can view all complaint evidence"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'complaint-evidence' AND
  EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  )
);

-- Allow service role to manage all files (for API operations)
CREATE POLICY "Service role can manage complaint evidence"
ON storage.objects FOR ALL
TO service_role
USING (bucket_id = 'complaint-evidence')
WITH CHECK (bucket_id = 'complaint-evidence');
