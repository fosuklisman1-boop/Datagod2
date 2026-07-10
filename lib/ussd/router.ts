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
import {
  handleRcMenu, handleRcSelectBoard, handleRcEnterQty, handleRcConfirm, handleRcPaymentMethod,
  handleRcMyVouchers, handleRcVoucherDetail,
  handleRcCheckBoard, handleRcCheckCandidateType, handleRcCheckMode,
  handleRcCheckVoucher,
  handleRcCheckIndex, handleRcCheckDob, handleRcCheckWaNumber, handleRcCheckYear,
  handleRcCheckConfirm, handleRcCheckPaymentMethod,
} from "./handlers/results-checker"
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

    const [
      { data: pendingData },
      { data: pendingAirtime },
      { data: pendingRc },
      { data: pendingCheck },
      { data: whitelistSetting },
      { data: pastOrder },
      { data: pastUssdOrder },
      { data: pastWhitelist },
    ] = await Promise.all([
      supabase.from("ussd_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("airtime_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("results_checker_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("results_check_requests").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
      // orders.phone_number = web/dashboard purchase recipient (completed payments only)
      supabase.from("orders").select("id").eq("phone_number", localPhone).eq("status", "completed").limit(1).maybeSingle(),
      // ussd_orders.dialing_phone = whoever placed the USSD call (completed payments only)
      supabase.from("ussd_orders").select("id").or(`dialing_phone.eq.${msisdn},dialing_phone.eq.${localPhone}`).eq("payment_status", "completed").limit(1).maybeSingle(),
      // admin-uploaded manual whitelist
      supabase.from("ussd_whitelist").select("id").eq("phone_number", localPhone).limit(1).maybeSingle(),
    ])

    const hasPurchased = !!(pastOrder || pastUssdOrder || pastWhitelist)
    const dataBlocked = whitelistSetting?.value?.enabled === true && !hasPurchased

    const candidates = [
      pendingData ? { id: pendingData.id, created_at: pendingData.created_at, table: undefined } : null,
      pendingAirtime ? { id: pendingAirtime.id, created_at: pendingAirtime.created_at, table: 'airtime_orders' as const } : null,
      pendingRc ? { id: pendingRc.id, created_at: pendingRc.created_at, table: 'results_checker_orders' as const } : null,
      pendingCheck ? { id: pendingCheck.id, created_at: pendingCheck.created_at, table: 'results_check_requests' as const } : null,
    ].filter(Boolean) as Array<{ id: string; created_at: string; table?: 'airtime_orders' | 'results_checker_orders' | 'results_check_requests' }>

    if (candidates.length) {
      candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const top = candidates[0]
      await setSession(sessionID, { step: 'SUBMIT_OTP', dialingPhone: msisdn, pendingOrderId: top.id, pendingOrderTable: top.table })
      return cont(
        `Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel`
      )
    }

    await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn, dataBlocked })
    return cont(mainMenu(!dataBlocked))
  }

  // Continuing request — route by current session step
  const session = await getSession(sessionID)

  if (!session) {
    // Session expired or missing — restart (no whitelist re-check; show full menu, user re-dials)
    await setSession(sessionID, { step: 'MAIN', dialingPhone: msisdn })
    return cont('Time limit exceeded.\n\n' + mainMenu())
  }

  const input = ussdString ?? ''

  switch (session.step) {
    case 'MAIN':
      return handleMain(input, sessionID, session)

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
      if (
        session.pendingOrderTable === 'airtime_orders' ||
        session.pendingOrderTable === 'results_checker_orders' ||
        session.pendingOrderTable === 'results_check_requests'
      ) {
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

    case 'RC_MENU':
      return handleRcMenu(input, sessionID, session)

    case 'RC_MY_VOUCHERS':
      return handleRcMyVouchers(input, sessionID, session)

    case 'RC_VOUCHER_DETAIL':
      return handleRcVoucherDetail(input, sessionID, session)

    case 'RC_SELECT_BOARD':
      return handleRcSelectBoard(input, sessionID, session)

    case 'RC_ENTER_QTY':
      return handleRcEnterQty(input, sessionID, session)

    case 'RC_CONFIRM':
      return handleRcConfirm(input, sessionID, session)

    case 'RC_PAYMENT_METHOD':
      return handleRcPaymentMethod(input, sessionID, session)

    case 'RC_CHECK_BOARD':
      return handleRcCheckBoard(input, sessionID, session)

    case 'RC_CHECK_CANDIDATE_TYPE':
      return handleRcCheckCandidateType(input, sessionID, session)

    case 'RC_CHECK_MODE':
      return handleRcCheckMode(input, sessionID, session)

    case 'RC_CHECK_VOUCHER':
      return handleRcCheckVoucher(input, sessionID, session)

    case 'RC_CHECK_INDEX':
      return handleRcCheckIndex(input, sessionID, session)

    case 'RC_CHECK_DOB':
      return handleRcCheckDob(input, sessionID, session)

    case 'RC_CHECK_WA_NUMBER':
      return handleRcCheckWaNumber(input, sessionID, session)

    case 'RC_CHECK_YEAR':
      return handleRcCheckYear(input, sessionID, session)

    case 'RC_CHECK_PAYMENT_METHOD':
      return handleRcCheckPaymentMethod(input, sessionID, session)

    case 'RC_CHECK_CONFIRM':
      return handleRcCheckConfirm(input, sessionID, session)

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
