-- Add admin tracking columns to order_download_batches table
-- This tracks which admin downloaded each batch

ALTER TABLE order_download_batches 
ADD COLUMN IF NOT EXISTS downloaded_by UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS downloaded_by_email TEXT;

-- Create index for efficient queries by admin
CREATE INDEX IF NOT EXISTS idx_order_download_batches_downloaded_by 
ON order_download_batches(downloaded_by);

-- Comment for documentation
COMMENT ON COLUMN order_download_batches.downloaded_by IS 'UUID of admin who downloaded this batch';
COMMENT ON COLUMN order_download_batches.downloaded_by_email IS 'Email of admin who downloaded this batch (denormalized for easy display)';
