-- 0076_revoke_authenticated_writes_financial_tables.sql
--
-- SECURITY FIX — RLS / grant hardening after a penetration test (2026-06-21).
--
-- Incident: disposable accounts (pentest*@tempmail.test, attacker*/test-rls-*@mailinator.com)
-- exploited two holes that existed because migration 0060_restore_public_grants
-- granted `authenticated` INSERT/UPDATE/DELETE on ~all public tables, leaving the
-- RLS policies as the only guard:
--   1. orders  — INSERT policy is ownership-only (with_check user_id = auth.uid()),
--                so a logged-in user could forge an order with ANY price/status
--                (proven: a TEST-001 / price 999999 / status 'delivered' row).
--   2. wallets — INSERT policy is ownership-only and does NOT constrain `balance`,
--                so a new account could mint itself wallet balance (proven: 100 GHS).
--
-- Money-out paths were NOT breached (wallet_transactions / user_wallets /
-- withdrawal_requests INSERT/UPDATE are service_role-only; users.role change is
-- pinned by with_check), but the forge/mint vectors are real.
--
-- Fix: revoke direct write access from app roles on the financial + order-integrity
-- tables. All legitimate writes go through server-side service-role endpoints
-- (supabaseAdmin), which bypass these grants — so app behaviour is unaffected.
-- `authenticated` retains SELECT (own-row, enforced by existing SELECT policies).
--
-- Applied to production via the Supabase Management API on 2026-06-21; this file
-- captures it so the fix survives re-runs / resets and is reviewable in the repo.
--
-- FOLLOW-UP (not in this migration): audit the remaining ~60 tables still carrying
-- the 0060 over-grant and lock the ones the browser client never writes, keeping
-- the few it legitimately writes (push tokens, contacts, complaints, etc.).

REVOKE INSERT, UPDATE, DELETE ON
  orders,
  shop_orders,
  api_orders,
  ussd_orders,
  ussd_shop_orders,
  afa_orders,
  ussd_afa_orders,
  airtime_orders,
  results_checker_orders,
  wallets,
  user_wallets,
  wallet_transactions,
  wallet_payments,
  wallet_refunds,
  transactions,
  withdrawal_requests,
  shop_profits,
  shop_available_balance,
  shop_packages,
  packages,
  subscription_plans,
  user_subscriptions,
  results_checker_inventory,
  payment_attempts,
  mtn_fulfillment_tracking,
  fulfillment_logs
FROM authenticated, anon;
