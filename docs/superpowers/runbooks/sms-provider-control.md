# SMS provider control runbook

Spec: `docs/superpowers/specs/2026-10-12-sms-provider-control-design.md`

Every SMS has a `type`. `lib/sms/categories.ts` maps the type to a category, and each category has its own provider selector: **Global**, **Moolre** or **Hubtel**. Global means "follow the primary and fallbacks" in the Provider routing card. A type not listed below falls into `system`.

## Categories

| Category | Default | Types |
|---|---|---|
| `otp` | Global | `phone_otp`, `otp_required`, `password_reset_link` |
| `order_confirmation_platform` | Moolre | `order_confirmed`, `order_payment_confirmed`, `order_confirmation`, `order_update`, `order_delivered`, `order_fulfilled`, `order_fulfilled_manual`, `order_cleared`, `order_blacklisted` (platform sender) |
| `order_confirmation_own_sender` | Hubtel | Order confirmations sent from a shop's own sender ID (billed in credits). Chosen by the caller, not by type |
| `payments_wallet` | Moolre | `wallet_topup_success`, `data_purchase_success`, `balance_updated`, `order_refund`, `subscription_success`, `results_check_payment`, `results_checker_delivery`, `results_checker_resend_sms`, `voucher_delivered`, `admin_credit`, `admin_debit`, `sms_activation`, `sms_bundle`, `sms_units_qty`, `sms_kyc`, any `airtime_*` not in security, any `subscription_expiry_*` |
| `admin_action_outcomes` | Moolre | `dealer_upgrade`, `user_suspension`, `user_restoration`, `shop_blocked`, `shop_unblocked`, `afa_registration`, `sub_agent_invite`, `mtn_registration_hold`, and `{withdrawal,shop,afa,results_check,sender_id,complaint}_{approved,rejected,completed,resolved}` |
| `security_alerts` | Global | `security_alert`, `password_changed`, `alert`, `fraud_alert`, `airtime_admin_alert`, `airtime_fraud_alert` |
| `system` | Moolre | Everything else (catch-all) |
| `admin_broadcast` | Global | `broadcast` |
| `customer_bulk` | Global | `shop_sms` |

## Changing a category

1. Admin > SMS Centre > Providers > **Provider routing by SMS type**.
2. Pick Global / Moolre / Hubtel per row, then press **Save** (separate from "Save routing" above).
3. Choosing Hubtel requires Hubtel credentials; otherwise the save is refused and the error is shown verbatim.
4. Settings are cached about 5 minutes per instance. The save clears the cache only on the instance that served it; other instances pick the change up within 5 minutes.

OTP: the selector is honoured, but if the failover breaker is open the lead is still forced to the fallback provider.

## Per-send pickers

- **Admin broadcast:** the broadcast compose screen has a provider picker (Moolre / Hubtel / "System default", which means the category routing applies). The choice is stored on `broadcast_logs.sms_provider` and reused by retries.
- **Customer bulk SMS (dashboard, shop, `/api/v1/sms/send`):** a picker is shown/honoured only when "Let customers choose the provider when sending bulk SMS" is ticked in the card. Otherwise the `customer_bulk` category applies. Hubtel solvency/wholesale gates still apply.

A per-send choice overrides the category.

## Deploy checklist

1. **Apply `migrations/20261020_sms_provider_control.sql` to prod BEFORE merging to main** (merging auto-deploys). Own-sender order confirmations default to Hubtel and write `provider_override`. If the code ships first: the `sms_send_logs` insert retries once without `provider_override` and logs "provider_override column missing - apply migration 20261020" (the send still goes out, the instant dispatch honours the pick), but later drain retries fall back to category routing; a broadcast with an explicit provider is refused with "Apply migration 20261020 (sms_provider column) before choosing a provider".
2. After deploy, watch the Moolre balance (system categories now lead with Moolre instead of Hubtel) and check distribution:
   ```sql
   select message_type, provider, count(*)
   from sms_logs
   where created_at > now() - interval '1 hour'
   group by 1, 2;
   ```
3. Do not enable tenant provider choice before the migration is applied.
4. **Rollback:** set every category to Global in the card; behaviour returns to the global primary/fallbacks, except OTP-category types (`otp_required`, `password_reset_link`, `phone_otp`), which keep OTP ordering and the failover breaker. Code rollback is safe once the migration is applied (columns are additive).

## Known limitations

- `password_reset_link` SMS bodies are not redacted in `sms_logs` (pre-existing; they are now in the OTP category).
- There is no separate admin compose screen beyond broadcast.
- Granularity is per category, not per individual message type.
- Own-sender vs platform order confirmations are decided by the calling code, not by the type string.
- **Solvency caveat:** the wholesale/solvency gates (`lib/sms/wholesale.ts`) still check only the PRIMARY provider's balance. Do not move `customer_bulk` or own-sender confirmations away from the primary, or enable tenant provider choice, without checking the other provider's balance first.
- **Global for own-sender** follows `customer_bulk` if that is set, else the primary.
- **Custom sender IDs** are never sent via Moolre while Hubtel is configured: a forced or category Moolre lead is replaced by Hubtel (tenant sender IDs are approved locally and may not exist at Moolre).
- The delivery-sync cron still treats only `phone_otp` as OTP (`app/api/cron/sms-delivery-sync/route.ts` lines 76 and 147).
- If the routing read fails, routing falls back to the built-in category defaults (Moolre-first for system categories), not to Global.
