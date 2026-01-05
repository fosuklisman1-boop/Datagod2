-- Migration: Drop unused indexes
-- Purpose: Reduce storage overhead and maintenance, improve write performance
-- Created: 2026-01-05
-- Note: These indexes have not been used since database creation based on Supabase linter analysis

-- afa_orders unused indexes
DROP INDEX IF EXISTS public.idx_afa_orders_order_code;
DROP INDEX IF EXISTS public.idx_afa_orders_transaction_code;
DROP INDEX IF EXISTS public.idx_afa_orders_status;
DROP INDEX IF EXISTS public.idx_afa_orders_created_at;

-- order_download_batches unused indexes
DROP INDEX IF EXISTS public.idx_order_download_batches_network;
DROP INDEX IF EXISTS public.idx_order_download_batches_batch_time;

-- shop_settings unused indexes
DROP INDEX IF EXISTS public.idx_shop_settings_updated_at;

-- complaints unused indexes
DROP INDEX IF EXISTS public.idx_complaints_status;

-- shop_available_balance unused indexes
DROP INDEX IF EXISTS public.idx_shop_available_balance_updated_at;

-- withdrawal_requests unused indexes
DROP INDEX IF EXISTS public.idx_withdrawal_requests_shop_id;

-- wallet_payments unused indexes
DROP INDEX IF EXISTS public.idx_wallet_payments_status;
DROP INDEX IF EXISTS public.idx_wallet_payments_paystack_transaction_id;

-- wallet_transactions unused indexes
DROP INDEX IF EXISTS public.idx_wallet_transactions_created_at;
DROP INDEX IF EXISTS public.idx_wallet_transactions_reference;

-- wallet_refunds unused indexes
DROP INDEX IF EXISTS public.idx_wallet_refunds_status;

-- network_logos unused indexes
DROP INDEX IF EXISTS public.idx_network_logos_name;

-- sms_logs unused indexes
DROP INDEX IF EXISTS public.idx_sms_status;
DROP INDEX IF EXISTS public.idx_sms_message_type;
DROP INDEX IF EXISTS public.idx_sms_reference_id;
DROP INDEX IF EXISTS public.idx_sms_phone;
DROP INDEX IF EXISTS public.idx_sms_sent_at;

-- sub_agent_shop_packages unused indexes
DROP INDEX IF EXISTS public.idx_sub_agent_shop_packages_active;

-- packages unused indexes
DROP INDEX IF EXISTS public.idx_packages_is_available;

-- fulfillment_logs unused indexes
DROP INDEX IF EXISTS public.idx_fulfillment_logs_order_type;
DROP INDEX IF EXISTS public.idx_fulfillment_logs_network;

-- sub_agent_catalog unused indexes
DROP INDEX IF EXISTS public.idx_sub_agent_catalog_active;

-- app_settings unused indexes
DROP INDEX IF EXISTS public.idx_app_settings_created_at;

-- users unused indexes
DROP INDEX IF EXISTS public.idx_users_onboarding_completed;

-- shop_invites unused indexes
DROP INDEX IF EXISTS public.idx_shop_invites_status;

-- shop_customers unused indexes
DROP INDEX IF EXISTS public.idx_shop_customers_last_purchase_at;
DROP INDEX IF EXISTS public.idx_shop_customers_created_at;

-- customer_tracking unused indexes
DROP INDEX IF EXISTS public.idx_customer_tracking_slug;
DROP INDEX IF EXISTS public.idx_customer_tracking_accessed_at;

-- webhook_attempts unused indexes
DROP INDEX IF EXISTS public.idx_webhook_attempts_status;
DROP INDEX IF EXISTS public.idx_webhook_attempts_attempted_at;

-- verification_attempts unused indexes
DROP INDEX IF EXISTS public.idx_verification_attempts_result;
DROP INDEX IF EXISTS public.idx_verification_attempts_attempted_at;

-- orders unused indexes
DROP INDEX IF EXISTS public.idx_orders_fulfillment_status;
