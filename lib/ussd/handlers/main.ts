import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import { cont, end, afaEnterNamePrompt, airtimeRecipientPrompt, rcMenu, resolveMainMenu, networkMenu, type MainMenuKey } from "../menus"
import { keyForDigit, renderMenuText } from "../menu-items"
import { setSession, deleteSession } from "../session"
import { getUssdServiceVisibility } from "../../ussd-service-visibility"
import { botMenusVisible, UZO_BOT_MENUS_HIDDEN } from "../bots/gate"
import { startNetworkPlans } from "../bots/network-plans"
import { startPayBills } from "../bots/pay-bills"
import type { UzoBotCtx } from "../bots/kit"
import { whatsappBotItemsVisible } from "../../whatsapp-bot/cashback-visibility"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * What the main menu shows. Combines the per-caller whitelist gate (existing, unrelated to the admin toggle) with
 * the admin's global service-visibility toggle — data bundle only shows if BOTH allow it; the other three legacy
 * services are gated only by the admin toggle. `bots` adds the commission-cashback bot items through their gate
 * (fail closed): `true` = the Uzo main USSD (cashback config AND the ussd visibility flags); `"whatsapp"` = the main
 * WhatsApp bot (cashback config AND the WhatsApp switches, whatsappBotItemsVisible). Without it they stay hidden, so
 * the map renders the legacy menu byte for byte.
 */
export async function mainMenuVisibility(dataBlocked: boolean, bots: boolean | "whatsapp"): Promise<Record<MainMenuKey, boolean>> {
  const adminVisibility = await getUssdServiceVisibility(supabase)
  const gate = bots === "whatsapp"
    ? await whatsappBotMenus()
    : bots ? await botMenusVisible(supabase, adminVisibility) : UZO_BOT_MENUS_HIDDEN
  return {
    data: !dataBlocked && adminVisibility.data,
    afa: adminVisibility.afa,
    airtime: adminVisibility.airtime,
    resultsChecker: adminVisibility.resultsChecker,
    // Network Plans is a data product: the data whitelist hides it exactly like Browse Services. Pay Bills is not.
    networkPlans: !dataBlocked && gate.networkPlans,
    payBills: gate.payBills,
  }
}

/** The main WhatsApp bot's items (WhatsApp switches AND the cashback gate; never throws, fails closed). */
async function whatsappBotMenus(): Promise<{ networkPlans: boolean; payBills: boolean }> {
  const v = await whatsappBotItemsVisible(supabase)
  return { networkPlans: v.networkPlans === true, payBills: v.payBills === true }
}

/**
 * `channel` "ussd" = the Uzo main USSD router (and the bot flows' "back to menu"): Network Plans / Pay Bills are shown
 * and dispatched under the Uzo gate. "whatsapp" = the main WhatsApp bot (lib/whatsapp-bot/router.ts): the same items
 * under the WhatsApp switches, started with the bot's own session store (lib/whatsapp-bot/bot-flows.ts). Any other
 * caller gets the legacy menu unchanged.
 */
export async function handleMain(
  input: string,
  sessionId: string,
  session: USSDSession,
  channel?: "ussd" | "whatsapp"
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone ?? ''
  const dataBlocked = session.dataBlocked === true

  const key = input.trim()

  if (key === '0') {
    await deleteSession(sessionId)
    return end('Thank you for using DataGod.')
  }

  const effective = await mainMenuVisibility(dataBlocked, channel === "whatsapp" ? "whatsapp" : channel === "ussd")
  const resolved = resolveMainMenu(effective)
  const matchedKey = keyForDigit(resolved, key)
  const botCtx: UzoBotCtx = { surface: "ussd", sessionId, dialingPhone, shopId: null }

  switch (matchedKey) {
    case 'data':
      await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone, dataBlocked })
      return cont(networkMenu())
    case 'afa':
      await setSession(sessionId, { step: 'AFA_ENTER_NAME', dialingPhone, dataBlocked })
      return cont(afaEnterNamePrompt())
    case 'airtime':
      await setSession(sessionId, { step: 'AIRTIME_ENTER_RECIPIENT', dialingPhone, dataBlocked })
      return cont(airtimeRecipientPrompt())
    case 'resultsChecker':
      await setSession(sessionId, { step: 'RC_MENU', dialingPhone, dataBlocked })
      return cont(rcMenu())
    // Only reachable when the gate showed the item (resolveMainMenu hides them otherwise).
    // WhatsApp: loaded lazily (the bot module imports this handler for its "back to menu").
    case 'networkPlans':
      if (channel === "whatsapp") return (await import("@/lib/whatsapp-bot/bot-flows")).startWaBotFlow("networkPlans", sessionId, session)
      return startNetworkPlans(botCtx, session)
    case 'payBills':
      if (channel === "whatsapp") return (await import("@/lib/whatsapp-bot/bot-flows")).startWaBotFlow("payBills", sessionId, session)
      return startPayBills(botCtx, session)
    default:
      return cont(renderMenuText('Welcome to Datagod', resolved, '0. Exit'))
  }
}
