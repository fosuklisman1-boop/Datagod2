-- Support Settings Table
CREATE TABLE IF NOT EXISTS support_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  support_whatsapp VARCHAR(20) NOT NULL,
  support_email VARCHAR(255),
  support_phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index
CREATE INDEX IF NOT EXISTS idx_support_settings_id ON support_settings(id);

-- Insert default support settings (can be updated by admin)
INSERT INTO support_settings (support_whatsapp, support_email, support_phone)
VALUES ('233501234567', 'support@datagod.com', '0501234567')
ON CONFLICT DO NOTHING;
