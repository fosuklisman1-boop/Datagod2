-- Closes a duplicate-webhook race in the WhatsApp inbound handler.
--
-- Meta (WhatsApp Business API) can redeliver the same inbound webhook event
-- within milliseconds of the first delivery. The handler's dedup check was a
-- SELECT-then-insert pattern (check if meta_message_id already exists, then
-- proceed) — a classic TOCTOU race: two near-simultaneous deliveries can both
-- pass the "not yet seen" check before either has inserted, so both get fully
-- processed (calling the AI, placing a real order, sending two conflicting
-- replies to the customer — e.g. one request's correct confirm screen
-- immediately followed by the other's confused "duplicate order" narration).
--
-- A partial unique index makes the INSERT itself the atomic dedup point:
-- whichever concurrent request's insert reaches Postgres first wins, and the
-- loser reliably gets a unique-violation (23505) instead of racing past a
-- non-atomic check. Scoped to direction='inbound' only — outbound rows also
-- store a meta_message_id (Meta's id for OUR sent message, used for delivery-
-- status updates) and are a different id namespace, not a redelivery concern.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_inbound_meta_id_unique
  ON whatsapp_messages (meta_message_id)
  WHERE direction = 'inbound' AND meta_message_id IS NOT NULL;
