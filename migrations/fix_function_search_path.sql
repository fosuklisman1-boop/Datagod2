-- =============================================
-- FIX FUNCTION SEARCH PATH SECURITY ISSUES
-- All functions should have immutable search_path
-- =============================================

-- Fix get_payment_verification_status
ALTER FUNCTION public.get_payment_verification_status SET search_path = '';

-- Fix is_payment_stuck
ALTER FUNCTION public.is_payment_stuck SET search_path = '';

-- Fix get_stuck_payments
ALTER FUNCTION public.get_stuck_payments SET search_path = '';

-- Fix update_notifications_timestamp
ALTER FUNCTION public.update_notifications_timestamp SET search_path = '';

-- Fix get_wallet_balance
ALTER FUNCTION public.get_wallet_balance SET search_path = '';

-- Fix debit_wallet
ALTER FUNCTION public.debit_wallet SET search_path = '';

-- Fix credit_wallet
ALTER FUNCTION public.credit_wallet SET search_path = '';

-- Fix update_wallet_balance
ALTER FUNCTION public.update_wallet_balance SET search_path = '';

-- Fix get_shop_available_balance
ALTER FUNCTION public.get_shop_available_balance SET search_path = '';

-- Fix get_shop_total_profit
ALTER FUNCTION public.get_shop_total_profit SET search_path = '';
