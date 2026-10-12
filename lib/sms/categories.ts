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

const OTP = new Set(["phone_otp", "otp_required", "password_reset_link", "otp", "login_otp"])
const ORDER_CONFIRMATION = new Set(["order_confirmed", "order_payment_confirmed"])
const PAYMENTS_WALLET = new Set([
  "wallet_topup_success",
  "data_purchase_success",
  "wallet_credited",
  "wallet_debited",
])
const SECURITY = new Set(["security_alert", "password_changed"])
const ADMIN_BROADCAST = new Set(["broadcast"])
const CUSTOMER_BULK = new Set(["shop_sms"])

const ADMIN_OUTCOME_PREFIX = /^(withdrawal|shop|afa|results_check|sender_id|complaint)_(approved|rejected|completed|resolved)$/

export function categoryOf(type: string): SmsCategory {
  const t = (type ?? "").trim()
  if (OTP.has(t)) return "otp"
  if (ORDER_CONFIRMATION.has(t)) return "order_confirmation_platform"
  if (PAYMENTS_WALLET.has(t) || t.startsWith("airtime_")) return "payments_wallet"
  if (SECURITY.has(t)) return "security_alerts"
  if (ADMIN_BROADCAST.has(t)) return "admin_broadcast"
  if (CUSTOMER_BULK.has(t)) return "customer_bulk" // before the shop_ prefix rule
  if (ADMIN_OUTCOME_PREFIX.test(t)) return "admin_action_outcomes"
  return "system"
}
