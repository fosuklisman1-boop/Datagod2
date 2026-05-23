-- Normalize pending_download → pending across all order tables.
-- The pending_download status was used as a secondary "queued for manual download"
-- marker, but all fetches now use a single "pending" check, so existing rows
-- with pending_download must be migrated to avoid being invisible to the app.

UPDATE orders       SET status       = 'pending' WHERE status       = 'pending_download';
UPDATE shop_orders  SET order_status = 'pending' WHERE order_status = 'pending_download';
UPDATE api_orders   SET status       = 'pending' WHERE status       = 'pending_download';
UPDATE ussd_orders  SET order_status = 'pending' WHERE order_status = 'pending_download';
UPDATE ussd_shop_orders SET order_status = 'pending' WHERE order_status = 'pending_download';
