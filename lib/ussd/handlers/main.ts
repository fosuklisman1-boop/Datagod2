import { UzoResponse } from "../types"
import { cont, end, mainMenu, afaEnterNamePrompt, airtimeRecipientPrompt, rcBoardMenu } from "../menus"
import { setSession, deleteSession } from "../session"
import { buildRcBoardOptions } from "./results-checker"

export async function handleMain(
  input: string,
  sessionId: string,
  dialingPhone: string
): Promise<UzoResponse> {
  switch (input.trim()) {
    case '1':
      await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone })
      return cont('Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n4. AT-iShare\n0. Back')
    case '2':
      await setSession(sessionId, { step: 'AFA_ENTER_NAME', dialingPhone })
      return cont(afaEnterNamePrompt())
    case '3':
      await setSession(sessionId, { step: 'AIRTIME_ENTER_RECIPIENT', dialingPhone })
      return cont(airtimeRecipientPrompt())
    case '4': {
      const boards = await buildRcBoardOptions()
      if (boards.length === 0) {
        return cont('Results Checker is\ncurrently unavailable.\n\n' + mainMenu())
      }
      await setSession(sessionId, { step: 'RC_SELECT_BOARD', dialingPhone, rcBoardOptions: boards })
      return cont(rcBoardMenu(boards))
    }
    case '0':
      await deleteSession(sessionId)
      return end('Thank you for using DataGod.')
    default:
      return cont(mainMenu())
  }
}
