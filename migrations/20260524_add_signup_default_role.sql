-- Add configurable default role for new sign-ups
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS signup_default_role text NOT NULL DEFAULT 'user'
    CHECK (signup_default_role IN ('user', 'dealer'));
