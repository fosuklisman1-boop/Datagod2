import { UzoResponse, USSDSession } from "../types"
import { cont, end, mainMenu, afaEnterNamePrompt, airtimeRecipientPrompt, rcMenu } from "../menus"
import { setSession, deleteSession } from "../session"

export async function handleMain(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone ?? ''
  const dataBlocked = session.dataBlocked === true

  const key = input.trim()

  if (dataBlocked) {
    // Renumbered menu: 1=AFA, 2=Airtime, 3=RC
    switch (key) {
      case '1':
        await setSession(sessionId, { step: 'AFA_ENTER_NAME', dialingPhone, dataBlocked })
        return cont(afaEnterNamePrompt())
      case '2':
        await setSession(sessionId, { step: 'AIRTIME_ENTER_RECIPIENT', dialingPhone, dataBlocked })
        return cont(airtimeRecipientPrompt())
      case '3':
        await setSession(sessionId, { step: 'RC_MENU', dialingPhone, dataBlocked })
        return cont(rcMenu())
      case '0':
        await deleteSession(sessionId)
        return end('Thank you for using DataGod.')
      default:
        return cont(mainMenu(false))
    }
  }

  switch (key) {
    case '1':
      await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone })
      return cont('Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n4. AT-iShare\n0. Back')
    case '2':
      await setSession(sessionId, { step: 'AFA_ENTER_NAME', dialingPhone })
      return cont(afaEnterNamePrompt())
    case '3':
      await setSession(sessionId, { step: 'AIRTIME_ENTER_RECIPIENT', dialingPhone })
      return cont(airtimeRecipientPrompt())
    case '4':
      await setSession(sessionId, { step: 'RC_MENU', dialingPhone })
      return cont(rcMenu())
    case '0':
      await deleteSession(sessionId)
      return end('Thank you for using DataGod.')
    default:
      return cont(mainMenu())
  }
}
