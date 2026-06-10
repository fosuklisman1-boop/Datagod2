// lib/whatsapp-bot/router.ts
import { createClient } from "@supabase/supabase-js"
import { getWaSession, setWaSession, deleteWaSession, extendWaSession } from "./session"
import { USSDSession, UzoResponse, BundleOption } from "@/lib/ussd/types"
import { handleMain } from "@/lib/ussd/handlers/main"
import {
  handleSelectNetwork, handleEnterRecipient,
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
  handleRcCheckBoard, handleRcCheckCandidateType, handleRcCheckMode,
  handleRcCheckVoucher,
  handleRcCheckIndex, handleRcCheckDob, handleRcCheckWaNumber, handleRcCheckYear,
  handleRcCheckConfirm, handleRcCheckConfirmMomo,
} from "@/lib/ussd/handlers/results-checker"
import { handleOtpSubmit } from "@/lib/ussd/handlers/otp"
import { handleStatus } from "@/lib/ussd/handlers/status"
import {
  mainMenu, networkMenu, rcMenu, airtimeRecipientPrompt, afaEnterNamePrompt,
  recipientPrompt, paymentMethodMenu,
  airtimePaymentMethodMenu, rcPaymentMethodMenu,
  rcCheckBoardMenu, rcCheckCandidateTypeMenu, rcCheckModeMenu,
  rcCheckVoucherPrompt, rcCheckIndexPrompt,
} from "@/lib/ussd/menus"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Replace USSD-specific "Redial" OTP instructions with WhatsApp-friendly text
function fixWaMomoMsg(msg: string): string {
  return msg
    .replace(/Received an OTP instead\?[^\n]*/gi, 'If you receive an OTP code, reply here with it.')
    .replace(/Redial\s+\S*\s*and\s+enter\s+the\s+code\.?/gi, 'Reply here with your OTP code.')
}

// ── WhatsApp bundle helpers (full list, no pagination) ───────────────────────

function fmtSize(size: string): string {
  const n = parseFloat(size)
  if (isNaN(n)) return size
  if (n < 1) return `${Math.round(n * 1000)}MB`
  return `${Number.isInteger(n) ? n : n}GB`
}

async function loadAllBundlesWa(
  network: string,
  priceTier: string,
  parentShopId?: string,
): Promise<BundleOption[]> {
  if (priceTier === 'sub_agent' && parentShopId) {
    const { data } = await supabase
      .from("sub_agent_catalog")
      .select("package_id, parent_price, packages!inner(id, size, network, active)")
      .eq("shop_id", parentShopId)
      .eq("packages.network", network)
      .eq("packages.active", true)
      .order("parent_price", { ascending: true })
      .order("package_id", { ascending: true })
    return (data ?? []).map((r: any) => ({
      id: r.packages.id,
      size: String(r.packages.size),
      price: Number(r.parent_price),
    }))
  }
  const { data } = await supabase
    .from("packages")
    .select("id, size, price, dealer_price")
    .eq("network", network)
    .eq("active", true)
    .order("price", { ascending: true })
    .order("id", { ascending: true })
  return (data ?? []).map((r: any) => ({
    id: r.id,
    size: String(r.size),
    price: Number(
      priceTier === 'dealer' && r.dealer_price && Number(r.dealer_price) > 0
        ? r.dealer_price
        : r.price
    ),
  }))
}

function bundleMenuWa(bundles: BundleOption[]): string {
  const lines = bundles.map((b, i) => `${i + 1}. ${fmtSize(b.size)} - GHS ${b.price.toFixed(2)}`)
  lines.push('0. Back')
  return 'Select Bundle:\n' + lines.join('\n')
}

async function handleSelectBundleWa(
  input: string,
  sessionId: string,
  session: USSDSession,
): Promise<UzoResponse> {
  if (input === '0') {
    await setWaSession(sessionId, { ...session, step: 'SELECT_NETWORK' })
    return { message: networkMenu(), ussdServiceOp: 2 }
  }
  const chosen = parseInt(input, 10)
  const allBundles = await loadAllBundlesWa(
    session.network ?? '',
    session.effectivePriceTier ?? 'regular',
    session.subAgentParentShopId,
  )
  if (isNaN(chosen) || chosen < 1 || chosen > allBundles.length) {
    return { message: bundleMenuWa(allBundles), ussdServiceOp: 2 }
  }
  const selected = allBundles[chosen - 1]
  await setWaSession(sessionId, {
    ...session,
    step: 'ENTER_RECIPIENT',
    bundleId: selected.id,
    bundleSize: String(selected.size),
    bundlePrice: selected.price,
  })
  return { message: recipientPrompt(), ussdServiceOp: 2 }
}

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

  // WhatsApp: intercept non-numeric freetext in menu-selection steps (where only digits are
  // valid). Known ordering keywords navigate directly; everything else escapes to the AI so
  // general questions get a natural response instead of a USSD-style numbered menu.
  const MENU_SELECTION_STEPS: ReadonlySet<string> = new Set([
    'MAIN', 'SELECT_NETWORK', 'SELECT_BUNDLE', 'CHECK_STATUS',
    'CONFIRM', 'PAYMENT_METHOD',
    'AFA_CONFIRM_AFA',
    'AIRTIME_SELECT_NETWORK', 'AIRTIME_CONFIRM', 'AIRTIME_PAYMENT_METHOD',
    'RC_MENU', 'RC_SELECT_BOARD', 'RC_CONFIRM', 'RC_PAYMENT_METHOD',
    'RC_MY_VOUCHERS', 'RC_VOUCHER_DETAIL',
    'RC_CHECK_BOARD', 'RC_CHECK_CANDIDATE_TYPE', 'RC_CHECK_MODE', 'RC_CHECK_CONFIRM',
  ])
  if (MENU_SELECTION_STEPS.has(session.step) && !/^\d+$/.test(input)) {
    const lc = input.toLowerCase()
    // Allow typing board name directly when on the check board selection screen
    if (session.step === 'RC_CHECK_BOARD') {
      const board = (lc.includes('wassce') || lc.includes('waec') || lc.includes('wasce')) ? 'WASSCE'
        : lc.includes('bece') ? 'BECE'
        : (lc.includes('novdec') || lc.includes('nov')) ? 'NOVDEC'
        : null
      if (board) {
        result = await handleRcCheckBoard(
          board === 'WASSCE' ? '1' : board === 'BECE' ? '2' : '3',
          sessionId,
          { ...session, rcCheckChannel: 'whatsapp' },
        )
        await extendWaSession(sessionId)
        return result.message
      }
    }
    if (session.step === 'RC_CHECK_CANDIDATE_TYPE') {
      if (lc.includes('school')) {
        result = await handleRcCheckCandidateType('1', sessionId, session)
        await extendWaSession(sessionId)
        return result.message
      }
      if (lc.includes('private')) {
        result = await handleRcCheckCandidateType('2', sessionId, session)
        await extendWaSession(sessionId)
        return result.message
      }
    }
    if (lc.includes('data') || lc.includes('bundle')) {
      await setWaSession(sessionId, { ...session, step: 'SELECT_NETWORK' })
      await extendWaSession(sessionId)
      return networkMenu()
    }
    if (lc.includes('airtime')) {
      await setWaSession(sessionId, { ...session, step: 'AIRTIME_ENTER_RECIPIENT' })
      await extendWaSession(sessionId)
      return airtimeRecipientPrompt()
    }
    if (lc.includes('afa') || lc.includes('registr')) {
      await setWaSession(sessionId, { ...session, step: 'AFA_ENTER_NAME' })
      await extendWaSession(sessionId)
      return afaEnterNamePrompt()
    }
    if (lc.includes('result') || lc.includes('checker') || lc.includes('waec') || lc.includes('bece') || lc.includes('voucher')) {
      await setWaSession(sessionId, { ...session, step: 'RC_MENU' })
      await extendWaSession(sessionId)
      return rcMenu()
    }
    // No ordering keyword — escape to AI for a natural response
    await deleteWaSession(sessionId)
    return ''
  }

  switch (session.step) {
    case 'MAIN':
      result = await handleMain(input, sessionId, session.dialingPhone ?? phone)
      break

    case 'SELECT_NETWORK':
      result = await handleSelectNetwork(input, sessionId, session)
      if (result.ussdServiceOp === 2) {
        const s2 = await getWaSession(sessionId)
        if (s2?.step === 'SELECT_BUNDLE' && s2.network) {
          // WhatsApp: show all bundles at once — no 5-per-page pagination needed
          const allBundles = await loadAllBundlesWa(s2.network, s2.effectivePriceTier ?? 'regular', s2.subAgentParentShopId)
          overrideMessage = bundleMenuWa(allBundles)
          await setWaSession(sessionId, { ...s2, bundleCache: allBundles, bundleTotal: allBundles.length })
        }
      }
      break

    case 'SELECT_BUNDLE':
      // WhatsApp: bypass paginated USSD handler — full list, direct index selection
      result = await handleSelectBundleWa(input, sessionId, session)
      break

    case 'ENTER_RECIPIENT':
      result = await handleEnterRecipient(input, sessionId, session)
      break

    case 'CONFIRM':
      if (input === '1' && (!session.userId || (session.walletBalance ?? 0) < (session.bundlePrice ?? 0))) {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE', waNextStep: 'CONFIRM_BUNDLE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleConfirm(input, sessionId, session)
        if (input === '1') {
          void tagOrderChannel(sessionId, phone, 'ussd_orders', result.ussdServiceOp === 17)
        }
      }
      break

    case 'PAYMENT_METHOD':
      if (input === '2') {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handlePaymentMethod(input, sessionId, session)
      }
      break

    case 'SUBMIT_OTP': {
      const isOtpLike = /^\d{4,8}$/.test(input.trim())
      const isCancel = input.trim() === '0'

      // Non-OTP freetext: user may have approved via MoMo push without entering an OTP
      if (!isOtpLike && !isCancel && session.pendingOrderId) {
        const done = await isOrderPaymentComplete(session.pendingOrderId, session.pendingOrderTable)
        if (done) {
          result = { message: 'Your payment was approved!\nOrder is being processed.\n\nSend any message to place another order.', ussdServiceOp: 17 }
          break
        }
        result = { message: 'Waiting for MoMo approval on your phone.\n\nEnter your OTP if you received one.\n\n0. Cancel', ussdServiceOp: 2 }
        break
      }

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
    }

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
      if (input === '1' && (!session.userId || (session.walletBalance ?? 0) < (session.airtimeAmount ?? 0))) {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE', waNextStep: 'CONFIRM_AIRTIME' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleAirtimeConfirm(input, sessionId, session)
        if (input === '1') {
          void tagOrderChannel(sessionId, phone, 'airtime_orders', false)
        }
      }
      break
    case 'AIRTIME_PAYMENT_METHOD':
      if (input === '2') {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleAirtimePaymentMethod(input, sessionId, session)
      }
      break

    case 'RC_MENU': {
      result = await handleRcMenu(input, sessionId, session)
      // Ensure check requests are tagged as whatsapp channel
      if (result.ussdServiceOp === 2) {
        const s2 = await getWaSession(sessionId)
        if (s2?.step === 'RC_CHECK_BOARD' || s2?.step === 'RC_CHECK_CANDIDATE_TYPE' || s2?.step === 'RC_CHECK_MODE') {
          await setWaSession(sessionId, { ...s2, rcCheckChannel: 'whatsapp' })
        }
      }
      break
    }
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
      if (input === '1' && (!session.userId || (session.walletBalance ?? 0) < (session.rcTotal ?? 0))) {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE', waNextStep: 'CONFIRM_RC' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleRcConfirm(input, sessionId, session)
        if (input === '1') {
          void tagOrderChannel(sessionId, phone, 'results_checker_orders', false)
        }
      }
      break
    case 'RC_PAYMENT_METHOD':
      if (input === '2') {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleRcPaymentMethod(input, sessionId, session)
      }
      break

    case 'RC_CHECK_BOARD':
      result = await handleRcCheckBoard(input, sessionId, session)
      break
    case 'RC_CHECK_CANDIDATE_TYPE':
      result = await handleRcCheckCandidateType(input, sessionId, session)
      break
    case 'RC_CHECK_MODE':
      result = await handleRcCheckMode(input, sessionId, session)
      break
    case 'RC_CHECK_VOUCHER':
      result = await handleRcCheckVoucher(input, sessionId, session)
      break
    case 'RC_CHECK_INDEX':
      result = await handleRcCheckIndex(input, sessionId, session)
      break
    case 'RC_CHECK_DOB':
      result = await handleRcCheckDob(input, sessionId, session)
      break
    case 'RC_CHECK_WA_NUMBER':
      // Not reached for WA channel (handleRcCheckDob skips to RC_CHECK_CONFIRM for WA)
      // Handled as passthrough just in case
      result = await handleRcCheckWaNumber(input, sessionId, session)
      break
    case 'RC_CHECK_YEAR':
      result = await handleRcCheckYear(input, sessionId, session)
      break
    case 'RC_CHECK_CONFIRM':
      if (input === '1') {
        // Always ask for MoMo number — don't auto-use the WhatsApp number
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE', waNextStep: 'CONFIRM_CHECK' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleRcCheckConfirm(input, sessionId, session)
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
  // Determine originating payment step from waNextStep (confirm paths) or pendingOrderTable
  const parentStep = session.waNextStep === 'CONFIRM_AIRTIME' ? 'AIRTIME_CONFIRM'
    : session.waNextStep === 'CONFIRM_RC' ? 'RC_CONFIRM'
    : session.waNextStep === 'CONFIRM_BUNDLE' ? 'CONFIRM'
    : session.waNextStep === 'CONFIRM_CHECK' ? 'RC_CHECK_CONFIRM'
    : session.pendingOrderTable === 'airtime_orders' ? 'AIRTIME_PAYMENT_METHOD'
    : session.pendingOrderTable === 'results_checker_orders' ? 'RC_PAYMENT_METHOD'
    : 'PAYMENT_METHOD'

  if (input.trim() === '0') {
    if (
      parentStep === 'CONFIRM' || parentStep === 'AIRTIME_CONFIRM' ||
      parentStep === 'RC_CONFIRM' || parentStep === 'RC_CHECK_CONFIRM'
    ) {
      // Return to the confirm step by resetting step (user can re-review the order)
      await setWaSession(sessionId, { ...session, step: parentStep as USSDSession['step'], waNextStep: undefined })
      return { message: 'Order cancelled. Send any message to continue.', ussdServiceOp: 17 }
    }
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

  // Overwrite dialingPhone and derive the correct Paystack provider from the entered number.
  const updatedSession: USSDSession = {
    ...session,
    dialingPhone: local,
    momoPhone: local,
    paystackProvider: paystackProviderFromPhone(local) ?? undefined,
    step: parentStep as USSDSession['step'],
    waNextStep: undefined,
  }
  await setWaSession(sessionId, updatedSession)

  // Handle direct-charge confirm paths (guest/no-wallet users)
  if (session.waNextStep === 'CONFIRM_BUNDLE') {
    const res = await handleConfirm('1', sessionId, updatedSession)
    void tagOrderChannel(sessionId, updatedSession.dialingPhone ?? sessionId, 'ussd_orders', res.ussdServiceOp === 17)
    return { ...res, message: fixWaMomoMsg(res.message) }
  }
  if (session.waNextStep === 'CONFIRM_AIRTIME') {
    const res = await handleAirtimeConfirm('1', sessionId, updatedSession)
    void tagOrderChannel(sessionId, sessionId, 'airtime_orders', false)
    return { ...res, message: fixWaMomoMsg(res.message) }
  }
  if (session.waNextStep === 'CONFIRM_RC') {
    const res = await handleRcConfirm('1', sessionId, updatedSession)
    void tagOrderChannel(sessionId, sessionId, 'results_checker_orders', false)
    return { ...res, message: fixWaMomoMsg(res.message) }
  }
  if (session.waNextStep === 'CONFIRM_CHECK') {
    const res = await handleRcCheckConfirmMomo(sessionId, updatedSession)
    return { ...res, message: fixWaMomoMsg(res.message) }
  }

  // Standard MoMo payment-method paths
  if (parentStep === 'PAYMENT_METHOD') {
    const res = await handlePaymentMethod('2', sessionId, updatedSession)
    return { ...res, message: fixWaMomoMsg(res.message) }
  }
  if (parentStep === 'AIRTIME_PAYMENT_METHOD') {
    const res = await handleAirtimePaymentMethod('2', sessionId, updatedSession)
    return { ...res, message: fixWaMomoMsg(res.message) }
  }
  const res = await handleRcPaymentMethod('2', sessionId, updatedSession)
  return { ...res, message: fixWaMomoMsg(res.message) }
}

// ── Order payment status check ────────────────────────────────────────────────

async function isOrderPaymentComplete(orderId: string, table?: string): Promise<boolean> {
  try {
    const tbl = table === 'airtime_orders' ? 'airtime_orders'
      : table === 'results_checker_orders' ? 'results_checker_orders'
      : 'ussd_orders'
    const { data } = await supabase.from(tbl).select('payment_status').eq('id', orderId).maybeSingle()
    return data?.payment_status === 'completed'
  } catch {
    return false
  }
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
