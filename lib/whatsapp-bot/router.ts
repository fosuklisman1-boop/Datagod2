// lib/whatsapp-bot/router.ts
import { createClient } from "@supabase/supabase-js"
import { getWaSession, setWaSession, deleteWaSession, extendWaSession } from "./session"
import { USSDSession, UzoResponse } from "@/lib/ussd/types"
import { handleMain } from "@/lib/ussd/handlers/main"
import {
  handleSelectNetwork, handleSelectBundle, handleEnterRecipient,
  handleConfirm, handlePaymentMethod, handleSubmitOtp,
} from "@/lib/ussd/handlers/bundles"
import {
  handleAfaEnterName, handleAfaEnterCard, handleAfaEnterLocation,
  handleAfaEnterRegion, handleAfaConfirm,
} from "@/lib/ussd/handlers/afa"
import {
  handleAirtimeEnterRecipient, handleAirtimeSelectNetwork,
  handleAirtimeEnterAmount, handleAirtimeConfirm, handleAirtimePaymentMethod,
} from "@/lib/ussd/handlers/airtime"
import {
  handleRcMenu, handleRcSelectBoard, handleRcEnterQty, handleRcConfirm,
  handleRcPaymentMethod, handleRcMyVouchers, handleRcVoucherDetail,
} from "@/lib/ussd/handlers/results-checker"
import { handleOtpSubmit } from "@/lib/ussd/handlers/otp"
import { handleStatus } from "@/lib/ussd/handlers/status"
import {
  mainMenu, bundleMenu, paymentMethodMenu,
  airtimePaymentMethodMenu, rcPaymentMethodMenu,
} from "@/lib/ussd/menus"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function waRouter(phone: string, text: string): Promise<string> {
  const sessionId = phone
  const session = await getWaSession(sessionId)

  if (!session) {
    return 'Your session expired. Send a message to start a new order.'
  }

  const input = text.trim()
  let result: UzoResponse = { message: mainMenu(), ussdServiceOp: 2 }
  // Used to override the (possibly truncated) message from a handler
  let overrideMessage: string | null = null

  switch (session.step) {
    case 'MAIN':
      result = await handleMain(input, sessionId, session.dialingPhone ?? phone)
      break

    case 'SELECT_NETWORK':
      result = await handleSelectNetwork(input, sessionId, session)
      // Re-render bundle list from session cache to avoid 160-char USSD truncation
      if (result.ussdServiceOp === 2) {
        const s2 = await getWaSession(sessionId)
        if (s2?.step === 'SELECT_BUNDLE' && s2.bundleCache) {
          overrideMessage = bundleMenu(s2.bundleCache, s2.bundlePage ?? 0, s2.bundleTotal ?? 0)
        }
      }
      break

    case 'SELECT_BUNDLE':
      result = await handleSelectBundle(input, sessionId, session)
      if (result.ussdServiceOp === 2) {
        const s2 = await getWaSession(sessionId)
        if (s2?.step === 'SELECT_BUNDLE' && s2.bundleCache) {
          overrideMessage = bundleMenu(s2.bundleCache, s2.bundlePage ?? 0, s2.bundleTotal ?? 0)
        }
      }
      break

    case 'ENTER_RECIPIENT':
      result = await handleEnterRecipient(input, sessionId, session)
      break

    case 'CONFIRM':
      result = await handleConfirm(input, sessionId, session)
      if (input === '1') {
        void tagOrderChannel(sessionId, phone, 'ussd_orders', result.ussdServiceOp === 17)
      }
      break

    case 'PAYMENT_METHOD':
      if (input === '2') {
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handlePaymentMethod(input, sessionId, session)
      }
      break

    case 'SUBMIT_OTP':
      if (session.pendingOrderTable === 'airtime_orders' || session.pendingOrderTable === 'results_checker_orders') {
        if (!session.pendingOrderId) {
          result = { message: 'Session error. Please start a new order.', ussdServiceOp: 17 }
        } else {
          result = await handleOtpSubmit(input, session.pendingOrderId, session.pendingOrderTable)
        }
      } else {
        result = await handleSubmitOtp(input, sessionId, session)
      }
      break

    case 'CHECK_STATUS':
      result = await handleStatus(input, sessionId, session)
      break

    case 'AFA_ENTER_NAME':
      result = await handleAfaEnterName(input, sessionId, session)
      break
    case 'AFA_ENTER_CARD':
      result = await handleAfaEnterCard(input, sessionId, session)
      break
    case 'AFA_ENTER_LOCATION':
      result = await handleAfaEnterLocation(input, sessionId, session)
      break
    case 'AFA_ENTER_REGION':
      result = await handleAfaEnterRegion(input, sessionId, session)
      break
    case 'AFA_CONFIRM_AFA':
      result = await handleAfaConfirm(input, sessionId, session)
      break

    case 'AIRTIME_ENTER_RECIPIENT':
      result = await handleAirtimeEnterRecipient(input, sessionId, session)
      break
    case 'AIRTIME_SELECT_NETWORK':
      result = await handleAirtimeSelectNetwork(input, sessionId, session)
      break
    case 'AIRTIME_ENTER_AMOUNT':
      result = await handleAirtimeEnterAmount(input, sessionId, session)
      break
    case 'AIRTIME_CONFIRM':
      result = await handleAirtimeConfirm(input, sessionId, session)
      if (input === '1') {
        void tagOrderChannel(sessionId, phone, 'airtime_orders', false)
      }
      break
    case 'AIRTIME_PAYMENT_METHOD':
      if (input === '2') {
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleAirtimePaymentMethod(input, sessionId, session)
      }
      break

    case 'RC_MENU':
      result = await handleRcMenu(input, sessionId, session)
      break
    case 'RC_MY_VOUCHERS':
      result = await handleRcMyVouchers(input, sessionId, session)
      break
    case 'RC_VOUCHER_DETAIL':
      result = await handleRcVoucherDetail(input, sessionId, session)
      break
    case 'RC_SELECT_BOARD':
      result = await handleRcSelectBoard(input, sessionId, session)
      break
    case 'RC_ENTER_QTY':
      result = await handleRcEnterQty(input, sessionId, session)
      break
    case 'RC_CONFIRM':
      result = await handleRcConfirm(input, sessionId, session)
      if (input === '1') {
        void tagOrderChannel(sessionId, phone, 'results_checker_orders', false)
      }
      break
    case 'RC_PAYMENT_METHOD':
      if (input === '2') {
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleRcPaymentMethod(input, sessionId, session)
      }
      break

    case 'WA_ENTER_PAYMENT_PHONE':
      result = await handleWaEnterPaymentPhone(input, sessionId, session)
      break

    default:
      await setWaSession(sessionId, { step: 'MAIN', dialingPhone: phone })
      result = { message: mainMenu(), ussdServiceOp: 2 }
  }

  if (result.ussdServiceOp === 17) {
    await deleteWaSession(sessionId)
  } else {
    // USSD handlers call setSession() which resets TTL to 120 s — restore to 30 min
    await extendWaSession(sessionId)
  }

  return overrideMessage ?? result.message
}

// ── WA_ENTER_PAYMENT_PHONE ────────────────────────────────────────────────────

async function handleWaEnterPaymentPhone(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  // Determine originating payment step from pendingOrderTable
  const parentStep = session.pendingOrderTable === 'airtime_orders'
    ? 'AIRTIME_PAYMENT_METHOD'
    : session.pendingOrderTable === 'results_checker_orders'
      ? 'RC_PAYMENT_METHOD'
      : 'PAYMENT_METHOD'

  if (input.trim() === '0') {
    const amount = parentStep === 'PAYMENT_METHOD' ? (session.bundlePrice ?? 0)
      : parentStep === 'AIRTIME_PAYMENT_METHOD' ? (session.airtimeAmount ?? 0)
      : (session.rcTotal ?? 0)
    const balance = session.walletBalance ?? 0
    const menu = parentStep === 'PAYMENT_METHOD' ? paymentMethodMenu(amount, balance)
      : parentStep === 'AIRTIME_PAYMENT_METHOD' ? airtimePaymentMethodMenu(amount, balance)
      : rcPaymentMethodMenu(amount, balance)
    await setWaSession(sessionId, { ...session, step: parentStep as USSDSession['step'] })
    return { message: menu, ussdServiceOp: 2 }
  }

  const raw = input.trim().replace(/\s+/g, '')
  const local = raw.startsWith('+233') ? '0' + raw.slice(4)
    : raw.startsWith('233') ? '0' + raw.slice(3)
    : raw

  if (!/^0[0-9]{9}$/.test(local)) {
    return {
      message: 'Invalid number.\nEnter a valid Ghana\nMoMo number:\n(e.g. 0244123456)\n\n0. Cancel',
      ussdServiceOp: 2,
    }
  }

  // Overwrite dialingPhone with the entered MoMo number so USSD payment
  // handlers derive the correct Paystack provider and charge the right account.
  const updatedSession: USSDSession = {
    ...session,
    dialingPhone: local,
    momoPhone: local,
    step: parentStep as USSDSession['step'],
  }
  await setWaSession(sessionId, updatedSession)

  if (parentStep === 'PAYMENT_METHOD') return handlePaymentMethod('2', sessionId, updatedSession)
  if (parentStep === 'AIRTIME_PAYMENT_METHOD') return handleAirtimePaymentMethod('2', sessionId, updatedSession)
  return handleRcPaymentMethod('2', sessionId, updatedSession)
}

// ── Channel tagging ───────────────────────────────────────────────────────────

async function tagOrderChannel(
  sessionId: string,
  phone: string,
  table: 'ussd_orders' | 'airtime_orders' | 'results_checker_orders',
  isDirectCharge: boolean
): Promise<void> {
  try {
    const s2 = await getWaSession(sessionId)
    const orderId = s2?.pendingOrderId
    if (orderId) {
      await supabase.from(table).update({ channel: 'whatsapp' }).eq("id", orderId)
      return
    }
    if (isDirectCharge && table === 'ussd_orders') {
      // Direct charge path: order was created inside handler, pendingOrderId not set in session.
      // Find the most recently created order for this phone (within 30 s) and tag it.
      const cutoff = new Date(Date.now() - 30_000).toISOString()
      await supabase.from("ussd_orders")
        .update({ channel: 'whatsapp' })
        .eq("dialing_phone", phone)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
    }
  } catch (e) {
    console.warn("[WA-ROUTER] tagOrderChannel failed (non-fatal):", e)
  }
}
