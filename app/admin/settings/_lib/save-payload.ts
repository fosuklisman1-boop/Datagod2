import { GATEWAY_PAGE_SETTINGS_KEYS } from "@/app/admin/gateway/_lib/fee-fields"

/**
 * The fields the Settings page's bulk "Save Settings" button PUTs to
 * /api/admin/settings. Payment fees and withdrawal limits live on
 * /admin/gateway now and are deliberately NOT part of this shape.
 */
export interface SettingsFormState {
  join_community_link: string
  join_group_link: string
  whatsapp_bot_number: string
  ordering_enabled: boolean
  announcement_enabled: boolean
  announcement_title: string
  announcement_message: string
  storefront_announcement_enabled: boolean
  storefront_announcement_title: string
  storefront_announcement_message: string
  price_adjustment_mtn: number
  price_adjustment_telecel: number
  price_adjustment_at_ishare: number
  price_adjustment_at_bigtime: number
  supplier_cost_per_gb_mtn: number
  supplier_cost_per_gb_telecel: number
  supplier_cost_per_gb_at_ishare: number
  supplier_cost_per_gb_at_bigtime: number
  signups_enabled: boolean
  wallet_topups_enabled: boolean
  upgrades_enabled: boolean
  ai_widget_services: string[]
  signup_default_role: "user" | "dealer"
}

/**
 * Body for PUT /api/admin/settings from the Settings page. The route updates
 * only keys present in the body, so stripping the gateway-page keys guarantees
 * a Settings save can never overwrite fees/withdrawal limits (defensive even if
 * a caller passes a wider object).
 */
export function buildSettingsSavePayload(state: SettingsFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...state }
  for (const k of GATEWAY_PAGE_SETTINGS_KEYS) delete payload[k]
  return payload
}
