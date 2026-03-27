-- Add rate limiting columns to user_api_keys
ALTER TABLE public.user_api_keys 
ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER DEFAULT 60;

-- Optional: add burst limit if we want to get fancy later
-- ALTER TABLE public.user_api_keys ADD COLUMN IF NOT EXISTS burst_limit INTEGER DEFAULT 20;

-- Documentation:
COMMENT ON COLUMN public.user_api_keys.rate_limit_per_min IS 'Maximum number of requests allowed per minute for this API key';
