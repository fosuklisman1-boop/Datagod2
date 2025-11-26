-- Fix foreign key constraint to CASCADE on delete
-- This allows packages to be deleted even if they're referenced in shop_packages

ALTER TABLE shop_packages
DROP CONSTRAINT shop_packages_package_id_fkey;

ALTER TABLE shop_packages
ADD CONSTRAINT shop_packages_package_id_fkey
  FOREIGN KEY (package_id)
  REFERENCES packages(id)
  ON DELETE CASCADE;
