-- Splits the single Terms of Service blob into a general section (account,
-- payment, wallet, agent/dealer policies -- applies regardless of which
-- services a shop/domain offers) plus 4 optional per-service addenda, so a
-- domain restricted to a subset of services never shows terms language for
-- services it doesn't actually sell.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS terms_content_data TEXT,
  ADD COLUMN IF NOT EXISTS terms_content_airtime TEXT,
  ADD COLUMN IF NOT EXISTS terms_content_results_checker TEXT,
  ADD COLUMN IF NOT EXISTS terms_content_bulk_sms TEXT;

-- One-time content migration: the existing "7. Results Checker Vouchers"
-- section is genuinely results-checker-specific (not applicable at all to a
-- domain that doesn't sell vouchers) -- move it out of the general blob into
-- its own column, and renumber the remaining general sections so they stay
-- sequential. Everything else in the general blob (account registration,
-- instant-delivery policy, buyer accuracy, processing times, payment
-- verification, wallet, agent/dealer/shop roles) applies regardless of which
-- services are enabled, so it stays general. data_bundles/airtime/bulk_sms
-- are intentionally left NULL -- there's no pre-existing product-specific
-- legal text for those to relocate, and admin-authored content shouldn't be
-- fabricated; the admin can fill them in from /admin/settings.
UPDATE app_settings
SET
  terms_content_results_checker = '1. Results Checker Vouchers
WAEC and School Results Checker Vouchers are strictly one-time-use digital products. Once a voucher has been delivered to you or used on any examination body''s portal, it cannot be refunded, replaced, or reused. Ensure you use your voucher promptly and keep it secure. DATAGOD bears no responsibility for vouchers used or misplaced after delivery.',
  terms_content = 'Welcome to DATAGOD. By accessing or using our platform, you agree to be bound by these Terms of Service. Please read them carefully before creating an account or making any purchase.

1. General Account Registration & Security
By creating an account on DATAGOD, you agree to provide truthful and accurate personal information including your full name, phone number, and email address. You are solely responsible for maintaining the confidentiality of your password and for all activities that occur under your account. Your Wallet balance is tied exclusively to your account and may not be transferred to another user. DATAGOD reserves the right to suspend or terminate any account found to have provided false information or engaged in suspicious activity.

2. Instant, Non-Refundable Delivery
All digital products are processed and delivered instantly upon successful payment or Wallet deduction. Once a transaction has been completed and the product delivered, it cannot be reversed, recalled, or refunded under any circumstances, except where explicitly covered under Section 4.

3. Buyer Accuracy Guarantee
You are solely responsible for verifying that the recipient''s phone number and (where applicable) the selected telecommunications network are 100% correct before confirming any order. DATAGOD will not be held liable for deliveries made to an incorrect phone number or wrong network as a result of user input errors. No refund, credit, or replacement will be issued in such cases.

4. Processing Times & 24-Hour Reporting Window
While the vast majority of transactions are fulfilled within seconds, occasional delays may occur due to network downtime or high traffic. If you do not receive your order within a reasonable time, you MUST report it to our support team within 24 hours of purchase. Failure to report within this window may result in forfeiture of eligibility for fulfillment or manual compensation.

5. Payment Verification & Stay-on-Page Policy
When paying via our Paystack-powered checkout, you MUST remain on the payment page until you receive the final confirmation screen. Closing or navigating away from the payment tab before this confirmation may result in your payment being recorded but your order remaining unprocessed. DATAGOD is not liable for order failures caused by premature tab closure. If this occurs, use the order tracking feature or contact support immediately with your payment reference.

6. Wallet Top-Ups & Withdrawals
Wallet top-ups are processed via Paystack and are subject to applicable gateway and platform fees displayed at checkout. Funds added to your Wallet are non-transferable and may only be used for purchases on the DATAGOD platform. Withdrawal requests are subject to a processing fee and may take up to 3 business days to complete. DATAGOD reserves the right to pause wallet top-ups or withdrawals during scheduled maintenance.

7. Agent, Dealer & Shop Roles
Users who subscribe to Agent or Dealer upgrade plans, or who operate Shops or Sub-Agent storefronts on the DATAGOD platform, are bound by the pricing guidelines, operational policies, and network provider rules set by DATAGOD. Sub-agents and shop owners must not set prices below the minimum floor prices defined by the platform. DATAGOD reserves the right to suspend, revoke, or downgrade any account found to be abusing the platform, violating network provider terms, or engaging in fraudulent activity.'
WHERE key IS NULL
  AND terms_content LIKE '%7. Results Checker Vouchers%';
