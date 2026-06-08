import { createClient } from "@supabase/supabase-js"
import { UzoRequest, UzoResponse } from "./types"
import { getSession, setSession, deleteSession } from "./session"
import { cont, end, enterShopCodeMenu, otpMenu } from "./menus"
import { handleEnterShopCode, handleSelectProduct } from "./handlers/shop"
import { handleSelectNetwork, handleSelectBundle, handleEnterRecipient, handleConfirm, handleSubmitOtp } from "./handlers/bundles"
import { handleShopAirtimeEnterRecipient, handleShopAirtimeSelectNetwork, handleShopAirtimeEnterAmount, handleShopAirtimeConfirm } from "./handlers/airtime"
import { handleShopRcSelectBoard, handleShopRcEnterQty, handleShopRcConfirm } from "./handlers/results-checker"
import { handleOtpSubmit } from "@/lib/ussd/handlers/otp"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TERMINATE_THRESHOLD = 29

export async function shopRouter(req: UzoRequest): Promise<UzoResponse> {
  const { sessionID, ussdServiceOp, ussdString, msisdn } = req
  const op = parseInt(ussdServiceOp, 10)

  if (op >= TERMINATE_THRESHOLD) {
    await deleteSession(sessionID)
    return end('Session ended.')
  }

  if (op === 1) {
    const localPhone = msisdn.startsWith('+233') ? '0' + msisdn.slice(4)
      : msisdn.startsWith('233') ? '0' + msisdn.slice(3)
      : msisdn
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const phoneFilter = `dialing_phone.eq.${msisdn},dialing_phone.eq.${localPhone}`

    // Check all three order types for a pending OTP; pick the most recent one.
    const [{ data: pendingBundle }, { data: pendingAirtime }, { data: pendingRc }] = await Promise.all([
      supabase.from("ussd_shop_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("airtime_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd_shop").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("results_checker_orders").select("id, created_at")
        .or(phoneFilter).eq("payment_status", "otp_required").eq("channel", "ussd_shop").gte("created_at", cutoff)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ])

    const candidates = [
      pendingBundle ? { id: pendingBundle.id, created_at: pendingBundle.created_at, table: undefined } : null,
      pendingAirtime ? { id: pendingAirtime.id, created_at: pendingAirtime.created_at, table: 'airtime_orders' as const } : null,
      pendingRc ? { id: pendingRc.id, created_at: pendingRc.created_at, table: 'results_checker_orders' as const } : null,
    ].filter(Boolean) as Array<{ id: string; created_at: string; table?: 'airtime_orders' | 'results_checker_orders' }>

    if (candidates.length) {
      candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const top = candidates[0]
      await setSession(sessionID, { step: 'SUBMIT_OTP', dialingPhone: msisdn, pendingOrderId: top.id, pendingOrderTable: top.table })
      return cont(otpMenu())
    }

    await setSession(sessionID, { step: 'ENTER_SHOP_CODE', dialingPhone: msisdn })
    return cont(enterShopCodeMenu())
  }

  const session = await getSession(sessionID)

  if (!session) {
    await setSession(sessionID, { step: 'ENTER_SHOP_CODE', dialingPhone: msisdn })
    return cont('Time limit exceeded.\n\n' + enterShopCodeMenu())
  }

  const input = ussdString ?? ''

  switch (session.step) {
    case 'ENTER_SHOP_CODE':
      return handleEnterShopCode(input, sessionID, session.dialingPhone ?? msisdn)

    case 'SELECT_PRODUCT':
      return handleSelectProduct(input, sessionID, session)

    case 'SELECT_NETWORK':
      return handleSelectNetwork(input, sessionID, session)

    case 'SELECT_BUNDLE':
      return handleSelectBundle(input, sessionID, session)

    case 'ENTER_RECIPIENT':
      return handleEnterRecipient(input, sessionID, session)

    case 'CONFIRM':
      return handleConfirm(input, sessionID, session)

    case 'SUBMIT_OTP':
      if (session.pendingOrderTable === 'airtime_orders' || session.pendingOrderTable === 'results_checker_orders') {
        return handleOtpSubmit(input, session.pendingOrderId!, session.pendingOrderTable)
      }
      return handleSubmitOtp(input, sessionID, session)

    case 'SHOP_AIRTIME_ENTER_RECIPIENT':
      return handleShopAirtimeEnterRecipient(input, sessionID, session)

    case 'SHOP_AIRTIME_SELECT_NETWORK':
      return handleShopAirtimeSelectNetwork(input, sessionID, session)

    case 'SHOP_AIRTIME_ENTER_AMOUNT':
      return handleShopAirtimeEnterAmount(input, sessionID, session)

    case 'SHOP_AIRTIME_CONFIRM':
      return handleShopAirtimeConfirm(input, sessionID, session)

    case 'SHOP_RC_SELECT_BOARD':
      return handleShopRcSelectBoard(input, sessionID, session)

    case 'SHOP_RC_ENTER_QTY':
      return handleShopRcEnterQty(input, sessionID, session)

    case 'SHOP_RC_CONFIRM':
      return handleShopRcConfirm(input, sessionID, session)

    default:
      await setSession(sessionID, { step: 'ENTER_SHOP_CODE', dialingPhone: msisdn })
      return cont(enterShopCodeMenu())
  }
}
