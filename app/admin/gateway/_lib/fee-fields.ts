// The admin_settings keys owned by /admin/gateway. /admin/settings must never
// send these (see app/admin/settings/_lib/save-payload.ts), and the gateway page
// sends only these, so a save on one page can never reset the other's values.

export const GATEWAY_PAGE_SETTINGS_KEYS = [
  "paystack_fee_percentage",
  "wallet_topup_fee_percentage",
  "withdrawal_fee_percentage",
  "withdrawal_fee_minimum",
  "minimum_withdrawal_amount",
] as const

export type GatewayPageSettingsKey = (typeof GATEWAY_PAGE_SETTINGS_KEYS)[number]

/** Only the gateway-page keys, and only when the value is a finite number. */
export function pickGatewaySettings(
  form: Record<string, unknown>,
): Partial<Record<GatewayPageSettingsKey, number>> {
  const out: Partial<Record<GatewayPageSettingsKey, number>> = {}
  for (const k of GATEWAY_PAGE_SETTINGS_KEYS) {
    const v = form[k]
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v
  }
  return out
}
