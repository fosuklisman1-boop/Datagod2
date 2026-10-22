// Gate for the commission-cashback bot menus on the Uzo main + shop USSD ("Network Plans", "Pay Bills").
// A menu shows only when the cashback config sells its group on bots (enabled && surfaces.bots && botGroups[group];
// bundles => Network Plans, bills => Pay Bills) AND its ussd_service_visibility flag is on. Fails closed.
import type { SupabaseClient } from "@supabase/supabase-js"
import { botGroupOn } from "@/lib/bot-commission/context"
import { getCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"
import { getUssdServiceVisibility, type UssdServiceVisibility } from "@/lib/ussd-service-visibility"

export interface UzoBotMenus { networkPlans: boolean; payBills: boolean }

export const UZO_BOT_MENUS_HIDDEN: Readonly<UzoBotMenus> = Object.freeze({ networkPlans: false, payBills: false })

/** Pure gate: the config's bots group switch AND the visibility flag (strictly `true`), per menu. */
export function uzoBotMenus(cfg: CashbackConfig, vis: Pick<UssdServiceVisibility, "networkPlans" | "payBills">): UzoBotMenus {
  return {
    networkPlans: vis.networkPlans === true && botGroupOn(cfg, "bundles"),
    payBills: vis.payBills === true && botGroupOn(cfg, "bills"),
  }
}

/**
 * Which bot menus the Uzo menus show right now. `visibility` = the map the caller already read (saves a read);
 * omitted, it is read here. Any read error hides both menus. Never throws.
 */
export async function botMenusVisible(db: SupabaseClient, visibility?: UssdServiceVisibility): Promise<UzoBotMenus> {
  try {
    const vis = visibility ?? (await getUssdServiceVisibility(db))
    if (vis.networkPlans !== true && vis.payBills !== true) return { ...UZO_BOT_MENUS_HIDDEN }
    return uzoBotMenus(await getCashbackConfig(db), vis)
  } catch (e) {
    console.error("[USSD-BOTS] menu gate unavailable; hiding bot menus:", e instanceof Error ? e.message : "error")
    return { ...UZO_BOT_MENUS_HIDDEN }
  }
}
