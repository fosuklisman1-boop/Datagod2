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

  switch (input.trim()) {
    case '1':
      if (dataBlocked) {
        return cont('Data bundles not available.\nSign up on our app\nto unlock this service.\n\n' + mainMenu(false))
      }
      await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone })
      return cont('Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n4. AT-iShare\n0. Back')
    case '2':
      await setSession(sessionId, { step: 'AFA_ENTER_NAME', dialingPhone, dataBlocked })
      return cont(afaEnterNamePrompt())
    case '3':
      await setSession(sessionId, { step: 'AIRTIME_ENTER_RECIPIENT', dialingPhone, dataBlocked })
      return cont(airtimeRecipientPrompt())
    case '4':
      await setSession(sessionId, { step: 'RC_MENU', dialingPhone, dataBlocked })
      return cont(rcMenu())
    case '0':
      await deleteSession(sessionId)
      return end('Thank you for using DataGod.')
    default:
      return cont(mainMenu(!dataBlocked))
  }
}
