// Admin display only: is Pay Bills / Network Plans live on each bot? An item is live on a bot only when the shared
// cashback bots gate (master AND surfaces.bots AND botGroups[group]) AND that bot's own switch are on:
//   - Hubtel USSD: hubtel_ussd_config.visibility.payBills / networkPlans (a missing flag means on, as the menu reads it)
//   - Uzo USSD (main + shop): ussd_service_visibility.payBills / networkPlans (on only when stored true)
//   - WhatsApp bots (main + shop): whatsapp_cashback_visibility.payBills / networkPlans (on only when stored true)
// A source that failed to load (null) reads as off, never on.
type Obj = Record<string, unknown> | null | undefined

export interface BotSurfaceStatus { gate: boolean; hubtel: boolean; uzo: boolean; whatsapp: boolean }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})

export function botSurfaceStatus(
  group: "bills" | "bundles",
  cashbackConfig: Obj,
  hubtelConfig: Obj,
  uzoVisibility: Obj,
  whatsappSwitches: Obj,
): BotSurfaceStatus {
  const c = obj(cashbackConfig)
  const gate = c.enabled === true && obj(c.surfaces).bots === true && obj(c.botGroups)[group] === true
  const key = group === "bills" ? "payBills" : "networkPlans"
  const hubtelFlag = hubtelConfig ? obj(obj(hubtelConfig).visibility)[key] !== false : false
  return {
    gate,
    hubtel: gate && hubtelFlag,
    uzo: gate && obj(uzoVisibility)[key] === true,
    whatsapp: gate && obj(whatsappSwitches)[key] === true,
  }
}
