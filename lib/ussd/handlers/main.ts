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

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * What the main menu shows. Combines the per-caller whitelist gate (existing, unrelated to the admin toggle) with
 * the admin's global service-visibility toggle — data bundle only shows if BOTH allow it; the other three legacy
 * services are gated only by the admin toggle. `bots` (Uzo main USSD only) adds the commission-cashback bot items
 * through their gate (cashback config AND visibility flag, fail closed); without it they stay hidden, so the map
 * renders the legacy menu byte for byte.
 */
export async function mainMenuVisibility(dataBlocked: boolean, bots: boolean): Promise<Record<MainMenuKey, boolean>> {
  const adminVisibility = await getUssdServiceVisibility(supabase)
  const gate = bots ? await botMenusVisible(supabase, adminVisibility) : UZO_BOT_MENUS_HIDDEN
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

/**
 * `channel` "ussd" = the Uzo main USSD router (and the bot flows' "back to menu"): only then are the Network Plans /
 * Pay Bills items shown and dispatched. Any other caller (the WhatsApp bot) gets the legacy menu unchanged.
 */
export async function handleMain(
  input: string,
  sessionId: string,
  session: USSDSession,
  channel?: "ussd"
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone ?? ''
  const dataBlocked = session.dataBlocked === true

  const key = input.trim()

  if (key === '0') {
    await deleteSession(sessionId)
    return end('Thank you for using DataGod.')
  }

  const effective = await mainMenuVisibility(dataBlocked, channel === "ussd")
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
    case 'networkPlans':
      return startNetworkPlans(botCtx, session)
    case 'payBills':
      return startPayBills(botCtx, session)
    default:
      return cont(renderMenuText('Welcome to Datagod', resolved, '0. Exit'))
  }
}
