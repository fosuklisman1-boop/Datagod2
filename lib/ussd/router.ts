import { UzoRequest, UzoResponse } from "./types"
import { getSession, setSession, deleteSession } from "./session"
import { cont, end, mainMenu } from "./menus"
import { handleMain } from "./handlers/main"
import { handleSelectNetwork, handleSelectBundle, handleEnterRecipient, handleConfirm, handlePaymentMethod, handleSubmitOtp } from "./handlers/bundles"
import { handleStatus } from "./handlers/status"
import { handleAfaEnterName, handleAfaEnterCard, handleAfaEnterLocation, handleAfaEnterRegion, handleAfaConfirm } from "./handlers/afa"

const TERMINATE_THRESHOLD = 29

export async function router(req: UzoRequest): Promise<UzoResponse> {
  const { sessionID, ussdServiceOp, ussdString, msisdn } = req
  const op = parseInt(ussdServiceOp, 10)

  // Terminating request — clean up and exit
  if (op >= TERMINATE_THRESHOLD) {
    await deleteSession(sessionID)
    return end('Session ended.')
  }

  // Initiating request — always show main menu
  if (op === 1) {
    await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn })
    return cont(mainMenu())
  }

  // Continuing request — route by current session step
  const session = await getSession(sessionID)

  if (!session) {
    // Session expired or missing — restart
    await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn })
    return cont('Session expired.\n\n' + mainMenu())
  }

  const input = ussdString ?? ''

  switch (session.step) {
    case 'MAIN':
      return handleMain(input, sessionID, session.dialingPhone ?? msisdn)

    case 'SELECT_NETWORK':
      return handleSelectNetwork(input, sessionID, session)

    case 'SELECT_BUNDLE':
      return handleSelectBundle(input, sessionID, session)

    case 'ENTER_RECIPIENT':
      return handleEnterRecipient(input, sessionID, session)

    case 'CONFIRM':
      return handleConfirm(input, sessionID, session)

    case 'PAYMENT_METHOD':
      return handlePaymentMethod(input, sessionID, session)

    case 'SUBMIT_OTP':
      return handleSubmitOtp(input, sessionID, session)

    case 'CHECK_STATUS':
      return handleStatus(input, sessionID, session)

    case 'AFA_ENTER_NAME':
      return handleAfaEnterName(input, sessionID, session)

    case 'AFA_ENTER_CARD':
      return handleAfaEnterCard(input, sessionID, session)

    case 'AFA_ENTER_LOCATION':
      return handleAfaEnterLocation(input, sessionID, session)

    case 'AFA_ENTER_REGION':
      return handleAfaEnterRegion(input, sessionID, session)

    case 'AFA_CONFIRM_AFA':
      return handleAfaConfirm(input, sessionID, session)

    default:
      await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn })
      return cont(mainMenu())
  }
}
