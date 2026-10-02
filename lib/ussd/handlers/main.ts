import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import { cont, end, afaEnterNamePrompt, airtimeRecipientPrompt, rcMenu, resolveMainMenu, networkMenu, type MainMenuKey } from "../menus"
import { keyForDigit, renderMenuText } from "../menu-items"
import { setSession, deleteSession } from "../session"
import { getUssdServiceVisibility } from "../../ussd-service-visibility"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function handleMain(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone ?? ''
  const dataBlocked = session.dataBlocked === true

  const key = input.trim()

  if (key === '0') {
    await deleteSession(sessionId)
    return end('Thank you for using DataGod.')
  }

  // Combine the per-caller whitelist gate (existing, unrelated to this
  // feature) with the admin's global service-visibility toggle — data
  // bundle only shows if BOTH allow it. The other three services are gated
  // only by the admin toggle.
  const adminVisibility = await getUssdServiceVisibility(supabase)
  const effective: Partial<Record<MainMenuKey, boolean>> = {
    data: !dataBlocked && adminVisibility.data,
    afa: adminVisibility.afa,
    airtime: adminVisibility.airtime,
    resultsChecker: adminVisibility.resultsChecker,
  }
  const resolved = resolveMainMenu(effective)
  const matchedKey = keyForDigit(resolved, key)

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
    default:
      return cont(renderMenuText('Welcome to Datagod', resolved, '0. Exit'))
  }
}
