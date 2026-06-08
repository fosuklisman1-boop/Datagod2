import { createClient } from "@supabase/supabase-js"
import { UzoRequest, UzoResponse } from "./types"
import { getSession, setSession, deleteSession } from "./session"
import { cont, end, mainMenu } from "./menus"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
import { handleMain } from "./handlers/main"
import { handleSelectNetwork, handleSelectBundle, handleEnterRecipient, handleConfirm, handlePaymentMethod, handleSubmitOtp } from "./handlers/bundles"
import { handleStatus } from "./handlers/status"
import { handleAfaEnterName, handleAfaEnterCard, handleAfaEnterLocation, handleAfaEnterRegion, handleAfaConfirm } from "./handlers/afa"
import { handleAirtimeEnterRecipient, handleAirtimeSelectNetwork, handleAirtimeEnterAmount, handleAirtimeConfirm, handleAirtimePaymentMethod } from "./handlers/airtime"
import { handleRcSelectBoard, handleRcEnterQty, handleRcConfirm, handleRcPaymentMethod } from "./handlers/results-checker"
import { handleOtpSubmit } from "./handlers/otp"

const TERMINATE_THRESHOLD = 29

export async function router(req: UzoRequest): Promise<UzoResponse> {
  const { sessionID, ussdServiceOp, ussdString, msisdn } = req
  const op = parseInt(ussdServiceOp, 10)

  // Terminating request — clean up and exit
  if (op >= TERMINATE_THRESHOLD) {
    await deleteSession(sessionID)
    return end('Session ended.')
  }

  // Initiating request — check for a pending OTP (data bundle, airtime, or
  // results-checker) before showing the main menu. Whichever the caller most
  // recently left in 'otp_required' is the one they redialed to complete.
  if (op === 1) {
    const localPhone = msisdn.startsWith('+233') ? '0' + msisdn.slice(4)
      : msisdn.startsWith('233') ? '0' + msisdn.slice(3)
      : msisdn
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const phoneFilter = `dialing_phone.eq.${msisdn},dialing_phone.eq.${localPhone}`

    const [{ data: pendingData }, { data: pendingAirtime }, { data: pendingRc }] = await Promise.all([
      supabase.from("ussd_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("airtime_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("results_checker_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ])

    const candidates = [
      pendingData ? { id: pendingData.id, created_at: pendingData.created_at, table: undefined } : null,
      pendingAirtime ? { id: pendingAirtime.id, created_at: pendingAirtime.created_at, table: 'airtime_orders' as const } : null,
      pendingRc ? { id: pendingRc.id, created_at: pendingRc.created_at, table: 'results_checker_orders' as const } : null,
    ].filter(Boolean) as Array<{ id: string; created_at: string; table?: 'airtime_orders' | 'results_checker_orders' }>

    if (candidates.length) {
      candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const top = candidates[0]
      await setSession(sessionID, { step: 'SUBMIT_OTP', dialingPhone: msisdn, pendingOrderId: top.id, pendingOrderTable: top.table })
      return cont(
        `Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel`
      )
    }

    await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn })
    return cont(mainMenu())
  }

  // Continuing request — route by current session step
  const session = await getSession(sessionID)

  if (!session) {
    // Session expired or missing — restart
    await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn })
    return cont('Time limit exceeded.\n\n' + mainMenu())
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
      if (session.pendingOrderTable === 'airtime_orders' || session.pendingOrderTable === 'results_checker_orders') {
        return handleOtpSubmit(input, session.pendingOrderId!, session.pendingOrderTable)
      }
      return handleSubmitOtp(input, sessionID, session)

    case 'CHECK_STATUS':
      return handleStatus(input, sessionID, session)

    case 'AIRTIME_ENTER_RECIPIENT':
      return handleAirtimeEnterRecipient(input, sessionID, session)

    case 'AIRTIME_SELECT_NETWORK':
      return handleAirtimeSelectNetwork(input, sessionID, session)

    case 'AIRTIME_ENTER_AMOUNT':
      return handleAirtimeEnterAmount(input, sessionID, session)

    case 'AIRTIME_CONFIRM':
      return handleAirtimeConfirm(input, sessionID, session)

    case 'AIRTIME_PAYMENT_METHOD':
      return handleAirtimePaymentMethod(input, sessionID, session)

    case 'RC_SELECT_BOARD':
      return handleRcSelectBoard(input, sessionID, session)

    case 'RC_ENTER_QTY':
      return handleRcEnterQty(input, sessionID, session)

    case 'RC_CONFIRM':
      return handleRcConfirm(input, sessionID, session)

    case 'RC_PAYMENT_METHOD':
      return handleRcPaymentMethod(input, sessionID, session)

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
