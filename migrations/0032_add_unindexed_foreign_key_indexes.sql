-- Migration: Add indexes on unindexed foreign keys
-- Purpose: Improve query performance on foreign key joins
-- Created: 2026-01-05

-- admin_settings.updated_by
CREATE INDEX IF NOT EXISTS idx_admin_settings_updated_by ON public.admin_settings(updated_by);

-- afa_registration_prices.updated_by
CREATE INDEX IF NOT EXISTS idx_afa_registration_prices_updated_by ON public.afa_registration_prices(updated_by);

-- customer_tracking.shop_order_id
CREATE INDEX IF NOT EXISTS idx_customer_tracking_shop_order_id ON public.customer_tracking(shop_order_id);

-- orders.user_id
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);

-- orders.package_id
CREATE INDEX IF NOT EXISTS idx_orders_package_id ON public.orders(package_id);

-- payment_attempts.shop_id
CREATE INDEX IF NOT EXISTS idx_payment_attempts_shop_id ON public.payment_attempts(shop_id);

-- shop_invites.accepted_by_user_id
CREATE INDEX IF NOT EXISTS idx_shop_invites_accepted_by_user_id ON public.shop_invites(accepted_by_user_id);

-- shop_orders.package_id
CREATE INDEX IF NOT EXISTS idx_shop_orders_package_id ON public.shop_orders(package_id);

-- shop_orders.parent_shop_id
CREATE INDEX IF NOT EXISTS idx_shop_orders_parent_shop_id ON public.shop_orders(parent_shop_id);

-- shop_orders.shop_package_id
CREATE INDEX IF NOT EXISTS idx_shop_orders_shop_package_id ON public.shop_orders(shop_package_id);

-- shop_packages.package_id
CREATE INDEX IF NOT EXISTS idx_shop_packages_package_id ON public.shop_packages(package_id);

-- transactions.user_id
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);

-- wallet_payments.shop_id
CREATE INDEX IF NOT EXISTS idx_wallet_payments_shop_id ON public.wallet_payments(shop_id);

-- withdrawal_requests.user_id
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON public.withdrawal_requests(user_id);
