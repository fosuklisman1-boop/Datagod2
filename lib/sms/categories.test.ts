import { describe, it, expect } from "vitest"
import { categoryOf, CATEGORY_DEFAULTS, CATEGORY_LABELS, SMS_CATEGORIES } from "./categories"

describe("categoryOf", () => {
  it.each([
    ["phone_otp", "otp"], ["otp_required", "otp"], ["password_reset_link", "otp"],
    ["order_confirmed", "order_confirmation_platform"], ["order_payment_confirmed", "order_confirmation_platform"],
    ["wallet_topup_success", "payments_wallet"], ["data_purchase_success", "payments_wallet"], ["airtime_completed", "payments_wallet"],
    ["withdrawal_approved", "admin_action_outcomes"], ["shop_rejected", "admin_action_outcomes"], ["complaint_resolved", "admin_action_outcomes"],
    ["security_alert", "security_alerts"], ["password_changed", "security_alerts"],
    ["broadcast", "admin_broadcast"], ["shop_sms", "customer_bulk"],
    ["alert", "security_alerts"], ["fraud_alert", "security_alerts"], ["airtime_admin_alert", "security_alerts"], ["airtime_fraud_alert", "security_alerts"],
    ["order_confirmation", "order_confirmation_platform"], ["order_update", "order_confirmation_platform"], ["order_delivered", "order_confirmation_platform"],
    ["order_fulfilled", "order_confirmation_platform"], ["order_fulfilled_manual", "order_confirmation_platform"], ["order_cleared", "order_confirmation_platform"], ["order_blacklisted", "order_confirmation_platform"],
    ["balance_updated", "payments_wallet"], ["order_refund", "payments_wallet"], ["subscription_success", "payments_wallet"], ["subscription_expiry_3d", "payments_wallet"],
    ["results_check_payment", "payments_wallet"], ["results_checker_delivery", "payments_wallet"], ["results_checker_resend_sms", "payments_wallet"], ["voucher_delivered", "payments_wallet"],
    ["admin_credit", "payments_wallet"], ["admin_debit", "payments_wallet"], ["sms_activation", "payments_wallet"], ["sms_bundle", "payments_wallet"], ["sms_units_qty", "payments_wallet"], ["sms_kyc", "payments_wallet"],
    ["dealer_upgrade", "admin_action_outcomes"], ["user_suspension", "admin_action_outcomes"], ["user_restoration", "admin_action_outcomes"], ["shop_blocked", "admin_action_outcomes"],
    ["shop_unblocked", "admin_action_outcomes"], ["afa_registration", "admin_action_outcomes"], ["sub_agent_invite", "admin_action_outcomes"], ["mtn_registration_hold", "admin_action_outcomes"],
    ["otp", "system"], ["login_otp", "system"], ["wallet_credited", "system"], ["wallet_debited", "system"],
    ["totally_new_type", "system"], ["", "system"],
  ])("%s -> %s", (t, c) => expect(categoryOf(t)).toBe(c))

  it("defaults cover every category", () => {
    for (const c of SMS_CATEGORIES) expect(["global", "moolre", "hubtel"]).toContain(CATEGORY_DEFAULTS[c])
  })

  it("has the verbatim default values", () => {
    expect(CATEGORY_DEFAULTS).toEqual({
      otp: "global",
      order_confirmation_platform: "moolre",
      order_confirmation_own_sender: "hubtel",
      payments_wallet: "moolre",
      admin_action_outcomes: "moolre",
      security_alerts: "global",
      system: "moolre",
      admin_broadcast: "global",
      customer_bulk: "global",
    })
  })

  it("has a non-empty label for every category", () => {
    for (const c of SMS_CATEGORIES) expect(CATEGORY_LABELS[c].length).toBeGreaterThan(0)
    expect(CATEGORY_LABELS.otp).toBe("One-time passcodes (OTP)")
  })
})
