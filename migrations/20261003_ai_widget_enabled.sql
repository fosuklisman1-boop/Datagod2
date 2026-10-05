-- Admin-level kill switch for the customer dashboard's floating AI assistant
-- button, separate from (and overriding) each user's own per-browser
-- show/hide preference (see components/dashboard/AIChatWidget.tsx's
-- localStorage-backed hide button).
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS ai_widget_enabled BOOLEAN DEFAULT true;
