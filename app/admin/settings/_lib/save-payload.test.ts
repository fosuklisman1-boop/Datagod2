import { describe, it, expect } from "vitest"
import { buildSettingsSavePayload, type SettingsFormState } from "./save-payload"
import { GATEWAY_PAGE_SETTINGS_KEYS } from "@/app/admin/gateway/_lib/fee-fields"

const sampleState: SettingsFormState = {
  join_community_link: "https://chat.whatsapp.com/x",
  join_group_link: "",
  whatsapp_bot_number: "233200000000",
  ordering_enabled: true,
  announcement_enabled: false,
  announcement_title: "",
  announcement_message: "",
  storefront_announcement_enabled: false,
  storefront_announcement_title: "",
  storefront_announcement_message: "",
  price_adjustment_mtn: 0,
  price_adjustment_telecel: 0,
  price_adjustment_at_ishare: 0,
  price_adjustment_at_bigtime: 0,
  supplier_cost_per_gb_mtn: 0,
  supplier_cost_per_gb_telecel: 0,
  supplier_cost_per_gb_at_ishare: 0,
  supplier_cost_per_gb_at_bigtime: 0,
  signups_enabled: false,
  wallet_topups_enabled: true,
  upgrades_enabled: true,
  ai_widget_services: ["data_bundles"],
  signup_default_role: "user",
}

describe("buildSettingsSavePayload", () => {
  it("never contains a gateway-page key", () => {
    const payload = buildSettingsSavePayload(sampleState)
    for (const k of GATEWAY_PAGE_SETTINGS_KEYS) expect(payload).not.toHaveProperty(k)
  })

  it("strips gateway-page keys even if they leak into the state", () => {
    const leaky = {
      ...sampleState,
      paystack_fee_percentage: 3,
      wallet_topup_fee_percentage: 0,
      withdrawal_fee_percentage: 0,
      withdrawal_fee_minimum: 0,
      minimum_withdrawal_amount: 5,
    } as SettingsFormState
    const payload = buildSettingsSavePayload(leaky)
    for (const k of GATEWAY_PAGE_SETTINGS_KEYS) expect(payload).not.toHaveProperty(k)
  })

  it("keeps the non-payment settings", () => {
    const payload = buildSettingsSavePayload(sampleState)
    expect(payload).toHaveProperty("signups_enabled", false)
    expect(payload).toHaveProperty("ordering_enabled", true)
    expect(payload).toHaveProperty("ai_widget_services", ["data_bundles"])
    expect(Object.keys(payload).sort()).toEqual(Object.keys(sampleState).sort())
  })
})
