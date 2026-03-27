-- Create user_api_keys table
CREATE TABLE IF NOT EXISTS public.user_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create user_api_logs table
CREATE TABLE IF NOT EXISTS public.user_api_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES public.user_api_keys(id) ON DELETE SET NULL,
    method TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    request_payload JSONB,
    response_payload JSONB,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_logs ENABLE ROW LEVEL SECURITY;

-- Policies for user_api_keys
CREATE POLICY "Users can view their own API keys"
    ON public.user_api_keys FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own API keys"
    ON public.user_api_keys FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own API keys"
    ON public.user_api_keys FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own API keys"
    ON public.user_api_keys FOR DELETE
    USING (auth.uid() = user_id);

-- Policies for user_api_logs
CREATE POLICY "Users can view their own API logs"
    ON public.user_api_logs FOR SELECT
    USING (auth.uid() = user_id);

-- Admin policies (assuming role column in users table)
-- Note: Service role already bypasses RLS, but these are good for clarity
CREATE POLICY "Admins can view all API keys"
    ON public.user_api_keys FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins can view all API logs"
    ON public.user_api_logs FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

-- Indexes
CREATE INDEX idx_user_api_keys_user_id ON public.user_api_keys(user_id);
CREATE INDEX idx_user_api_keys_key_hash ON public.user_api_keys(key_hash);
CREATE INDEX idx_user_api_logs_user_id ON public.user_api_logs(user_id);
CREATE INDEX idx_user_api_logs_created_at ON public.user_api_logs(created_at);
