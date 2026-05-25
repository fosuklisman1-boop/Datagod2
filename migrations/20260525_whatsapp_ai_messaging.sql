-- WhatsApp AI messaging audit tables

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  user_id UUID REFERENCES auth.users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  latest_inbound_at TIMESTAMP WITH TIME ZONE,
  latest_outbound_at TIMESTAMP WITH TIME ZONE,
  last_message_preview TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  direction VARCHAR(20) NOT NULL CHECK (direction IN ('inbound', 'outbound', 'status')),
  phone_number VARCHAR(20) NOT NULL,
  message TEXT,
  meta_message_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'sent',
  error_message TEXT,
  tool_context JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone ON whatsapp_conversations(phone_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_user ON whatsapp_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_meta_id ON whatsapp_messages(meta_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone_created ON whatsapp_messages(phone_number, created_at DESC);

ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view whatsapp conversations" ON whatsapp_conversations;
CREATE POLICY "Admins can view whatsapp conversations"
  ON whatsapp_conversations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view whatsapp messages" ON whatsapp_messages;
CREATE POLICY "Admins can view whatsapp messages"
  ON whatsapp_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Service role full access on whatsapp conversations" ON whatsapp_conversations;
CREATE POLICY "Service role full access on whatsapp conversations"
  ON whatsapp_conversations FOR ALL
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on whatsapp messages" ON whatsapp_messages;
CREATE POLICY "Service role full access on whatsapp messages"
  ON whatsapp_messages FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT ALL ON whatsapp_conversations TO service_role;
GRANT ALL ON whatsapp_messages TO service_role;
GRANT SELECT ON whatsapp_conversations TO authenticated;
GRANT SELECT ON whatsapp_messages TO authenticated;
