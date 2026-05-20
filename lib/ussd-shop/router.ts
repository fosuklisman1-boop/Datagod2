import { createClient } from "@supabase/supabase-js"
import { UzoRequest, UzoResponse } from "./types"
import { getSession, setSession, deleteSession } from "./session"
import { cont, end, enterShopCodeMenu, otpMenu } from "./menus"
import { handleEnterShopCode } from "./handlers/shop"
import { handleSelectNetwork, handleSelectBundle, handleEnterRecipient, handleConfirm, handleSubmitOtp } from "./handlers/bundles"

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
    // Check for a pending OTP order on this phone number (cross-session OTP)
    const localPhone = msisdn.startsWith('+233') ? '0' + msisdn.slice(4)
      : msisdn.startsWith('233') ? '0' + msisdn.slice(3)
      : msisdn
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    const { data: pendingOtp } = await supabase
      .from("ussd_shop_orders")
      .select("id")
      .or(`dialing_phone.eq.${msisdn},dialing_phone.eq.${localPhone}`)
      .eq("payment_status", "otp_required")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (pendingOtp) {
      await setSession(sessionID, { step: 'SUBMIT_OTP', dialingPhone: msisdn, pendingOrderId: pendingOtp.id })
      return cont(otpMenu())
    }

    await setSession(sessionID, { step: 'ENTER_SHOP_CODE', dialingPhone: msisdn })
    return cont(enterShopCodeMenu())
  }

  const session = await getSession(sessionID)

  if (!session) {
    await setSession(sessionID, { step: 'ENTER_SHOP_CODE', dialingPhone: msisdn })
    return cont('Session expired.\n\n' + enterShopCodeMenu())
  }

  const input = ussdString ?? ''

  switch (session.step) {
    case 'ENTER_SHOP_CODE':
      return handleEnterShopCode(input, sessionID, session.dialingPhone ?? msisdn)

    case 'SELECT_NETWORK':
      return handleSelectNetwork(input, sessionID, session)

    case 'SELECT_BUNDLE':
      return handleSelectBundle(input, sessionID, session)

    case 'ENTER_RECIPIENT':
      return handleEnterRecipient(input, sessionID, session)

    case 'CONFIRM':
      return handleConfirm(input, sessionID, session)

    case 'SUBMIT_OTP':
      return handleSubmitOtp(input, sessionID, session)

    default:
      await setSession(sessionID, { step: 'ENTER_SHOP_CODE', dialingPhone: msisdn })
      return cont(enterShopCodeMenu())
  }
}
