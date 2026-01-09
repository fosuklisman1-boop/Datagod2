-- Add status column to order_download_batches table
ALTER TABLE order_download_batches
ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'completed';

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_order_download_batches_status ON order_download_batches(status);
