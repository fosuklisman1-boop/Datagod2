-- Account registration and wallet top-ups/withdrawals are dashboard-only
-- concepts -- a guest customer buying from a shop storefront never creates
-- an account or touches a wallet, so showing those terms there is noise at
-- best and confusing at worst. Splits them out of the general blob into
-- their own column, shown on the main /terms page (the full platform
-- picture) but never on a shop storefront.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS terms_content_account TEXT;

UPDATE app_settings
SET
  terms_content_account = '1. General Account Registration & Security
By creating an account on DATAGOD, you agree to provide truthful and accurate personal information including your full name, phone number, and email address. You are solely responsible for maintaining the confidentiality of your password and for all activities that occur under your account. Your Wallet balance is tied exclusively to your account and may not be transferred to another user. DATAGOD reserves the right to suspend or terminate any account found to have provided false information or engaged in suspicious activity.

2. Wallet Top-Ups & Withdrawals
Wallet top-ups are processed via Paystack and are subject to applicable gateway and platform fees displayed at checkout. Funds added to your Wallet are non-transferable and may only be used for purchases on the DATAGOD platform. Withdrawal requests are subject to a processing fee and may take up to 3 business days to complete. DATAGOD reserves the right to pause wallet top-ups or withdrawals during scheduled maintenance.',
  terms_content = 'Welcome to DATAGOD. By accessing or using our platform, you agree to be bound by these Terms of Service. Please read them carefully before creating an account or making any purchase.

1. Instant, Non-Refundable Delivery
All digital products are processed and delivered instantly upon successful payment or Wallet deduction. Once a transaction has been completed and the product delivered, it cannot be reversed, recalled, or refunded under any circumstances, except where explicitly covered under Section 3.

2. Buyer Accuracy Guarantee
You are solely responsible for verifying that the recipient''s phone number and (where applicable) the selected telecommunications network are 100% correct before confirming any order. DATAGOD will not be held liable for deliveries made to an incorrect phone number or wrong network as a result of user input errors. No refund, credit, or replacement will be issued in such cases.

3. Processing Times & 24-Hour Reporting Window
While the vast majority of transactions are fulfilled within seconds, occasional delays may occur due to network downtime or high traffic. If you do not receive your order within a reasonable time, you MUST report it to our support team within 24 hours of purchase. Failure to report within this window may result in forfeiture of eligibility for fulfillment or manual compensation.

4. Payment Verification & Stay-on-Page Policy
When paying via our Paystack-powered checkout, you MUST remain on the payment page until you receive the final confirmation screen. Closing or navigating away from the payment tab before this confirmation may result in your payment being recorded but your order remaining unprocessed. DATAGOD is not liable for order failures caused by premature tab closure. If this occurs, use the order tracking feature or contact support immediately with your payment reference.

5. Agent, Dealer & Shop Roles
Users who subscribe to Agent or Dealer upgrade plans, or who operate Shops or Sub-Agent storefronts on the DATAGOD platform, are bound by the pricing guidelines, operational policies, and network provider rules set by DATAGOD. Sub-agents and shop owners must not set prices below the minimum floor prices defined by the platform. DATAGOD reserves the right to suspend, revoke, or downgrade any account found to be abusing the platform, violating network provider terms, or engaging in fraudulent activity.'
WHERE key IS NULL
  AND terms_content LIKE '%1. General Account Registration%';
