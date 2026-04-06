-- Creating table to track password reset requested link and timing to enforce 5-minute expiry
CREATE TABLE IF NOT EXISTS public.password_reset_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    phone_number TEXT,
    reset_token TEXT, -- We might not need the actual token if we are using Supabase generateLink, but good to have a record
    ip_address TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    used BOOLEAN DEFAULT false
);

-- Index for fast lookup by user_id
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user_id ON public.password_reset_requests(user_id);

-- RLS policies
ALTER TABLE public.password_reset_requests ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write to this securely
CREATE POLICY "Service Role Full Access" ON public.password_reset_requests
    FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role');
