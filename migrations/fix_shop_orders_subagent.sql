-- Make shop_package_id nullable for sub-agent orders
-- Sub-agents don't have records in shop_packages, so we can't enforce this FK for them

ALTER TABLE shop_orders 
DROP CONSTRAINT IF EXISTS shop_orders_shop_package_id_fkey;

ALTER TABLE shop_orders
ADD CONSTRAINT shop_orders_shop_package_id_fkey 
FOREIGN KEY (shop_package_id) 
REFERENCES shop_packages(id) 
ON DELETE SET NULL 
DEFERRABLE INITIALLY DEFERRED;

-- Make shop_package_id nullable
ALTER TABLE shop_orders 
ALTER COLUMN shop_package_id DROP NOT NULL;

-- Add comment explaining the column usage
COMMENT ON COLUMN shop_orders.shop_package_id IS 'References shop_packages for regular shops. NULL for sub-agent orders (which use package_id directly).';
