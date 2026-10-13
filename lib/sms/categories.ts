/**
 * SMS message categories — maps a notification/message `type` string to a routing category,
 * so an admin can pick the provider (global | moolre | hubtel) per category.
 * Pure module: no I/O.
 */

export type SmsCategory =
  | "otp"
  | "order_confirmation_platform"
  | "order_confirmation_own_sender"
  | "payments_wallet"
  | "admin_action_outcomes"
  | "security_alerts"
  | "system"
  | "admin_broadcast"
  | "customer_bulk"

export type CategoryProvider = "global" | "moolre" | "hubtel"

export const SMS_CATEGORIES: readonly SmsCategory[] = [
  "otp",
  "order_confirmation_platform",
  "order_confirmation_own_sender",
  "payments_wallet",
  "admin_action_outcomes",
  "security_alerts",
  "system",
  "admin_broadcast",
  "customer_bulk",
]

export const CATEGORY_DEFAULTS: Record<SmsCategory, CategoryProvider> = {
  otp: "global",
  order_confirmation_platform: "moolre",
  order_confirmation_own_sender: "hubtel",
  payments_wallet: "moolre",
  admin_action_outcomes: "moolre",
  security_alerts: "global",
  system: "moolre",
  admin_broadcast: "global",
  customer_bulk: "global",
}

export const CATEGORY_LABELS: Record<SmsCategory, string> = {
  otp: "One-time passcodes (OTP)",
  order_confirmation_platform: "Order confirmations (platform sender)",
  order_confirmation_own_sender: "Order confirmations (shop's own sender)",
  payments_wallet: "Payments, wallet and purchases",
  admin_action_outcomes: "Admin action outcomes",
  security_alerts: "Security alerts",
  system: "System / other",
  admin_broadcast: "Admin broadcasts",
  customer_bulk: "Customer bulk SMS",
}

export const CATEGORY_HINTS: Record<SmsCategory, string> = {
  otp: "One-time codes, USSD payment OTP prompts, password-reset links",
  order_confirmation_platform: "Order status messages sent from the Datagod sender",
  order_confirmation_own_sender: "Order status messages sent from a shop's own sender ID",
  payments_wallet: "Top-ups, purchases, refunds, vouchers, airtime, subscriptions, SMS bundles",
  admin_action_outcomes: "Approvals and rejections for withdrawals, shops, AFA, sender IDs, complaints; account suspensions and restorations, dealer upgrades, sub-agent invites, MTN registration holds",
  security_alerts: "Security and fraud alerts, password changes",
  system: "Anything not listed elsewhere",
  admin_broadcast: "Admin broadcast messages",
  customer_bulk: "Bulk SMS sent by customers and shops",
}

const OTP = new Set(["phone_otp", "otp_required", "password_reset_link"])
const ORDER_CONFIRMATION = new Set([
  "order_confirmed", "order_payment_confirmed", "order_confirmation", "order_update", "order_delivered",
  "order_fulfilled", "order_fulfilled_manual", "order_cleared", "order_blacklisted",
])
const PAYMENTS_WALLET = new Set([
  "wallet_topup_success", "data_purchase_success", "balance_updated", "order_refund", "subscription_success",
  "results_check_payment", "results_checker_delivery", "results_checker_resend_sms", "voucher_delivered",
  "admin_credit", "admin_debit", "sms_activation", "sms_bundle", "sms_units_qty", "sms_kyc",
])
const SECURITY = new Set([
  "security_alert", "password_changed", "alert", "fraud_alert", "airtime_admin_alert", "airtime_fraud_alert",
])
const ADMIN_BROADCAST = new Set(["broadcast"])
const CUSTOMER_BULK = new Set(["shop_sms"])
const ADMIN_OUTCOMES = new Set([
  "dealer_upgrade", "user_suspension", "user_restoration", "shop_blocked", "shop_unblocked",
  "afa_registration", "sub_agent_invite", "mtn_registration_hold",
])

const ADMIN_OUTCOME_PREFIX = /^(withdrawal|shop|afa|results_check|sender_id|complaint)_(approved|rejected|completed|resolved)$/

export function categoryOf(type: string): SmsCategory {
  const t = (type ?? "").trim()
  if (OTP.has(t)) return "otp"
  if (SECURITY.has(t)) return "security_alerts" // before the airtime_ prefix rule
  if (ORDER_CONFIRMATION.has(t)) return "order_confirmation_platform"
  if (PAYMENTS_WALLET.has(t) || t.startsWith("airtime_") || t.startsWith("subscription_expiry_")) return "payments_wallet"
  if (ADMIN_BROADCAST.has(t)) return "admin_broadcast"
  if (CUSTOMER_BULK.has(t)) return "customer_bulk" // before the shop_ prefix rule
  if (ADMIN_OUTCOMES.has(t) || ADMIN_OUTCOME_PREFIX.test(t)) return "admin_action_outcomes"
  return "system"
}

/**
 * What "Global" resolves to for a category, for the admin hint beside the selector.
 * OTP: SMS_OTP_PROVIDER (env) when set, else the primary. Own-sender confirmations: follow
 * customer_bulk when that is not Global, else the primary. Everything else: the primary.
 */
export function resolveGlobalHint(
  category: SmsCategory,
  routing: { primary: string; categoryProviders?: Partial<Record<SmsCategory, CategoryProvider>> },
): string {
  if (category === "otp") return `${routing.primary} (OTP may use a dedicated provider)`
  if (category === "order_confirmation_own_sender") {
    const bulk = routing.categoryProviders?.customer_bulk
    if (bulk && bulk !== "global") return bulk
  }
  return routing.primary
}
