import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import { cont, end, mainMenu, afaEnterNamePrompt, afaEnterCardPrompt, afaEnterLocationPrompt, afaEnterRegionPrompt, afaConfirmMenu } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { setWaSession } from "../../whatsapp-bot/session"
import { sendWhatsAppText } from "../../whatsapp-bot/send"
import { sendSMS, SMSTemplates } from "../../sms-service"
import {
  guardedReprice, isUssdHubtelPayer, startUssdCharge, ussdChargeSurface, ussdOrderAmount, type UssdChannel, type UssdPrice,
} from "../gateway-charge"
import { getUssdServiceVisibility } from "../../ussd-service-visibility"
import { parseGhanaCardNumber } from "../../ghana-card"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── AFA_ENTER_NAME ────────────────────────────────────────────────────────────
export async function handleAfaEnterName(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    const visibility = await getUssdServiceVisibility(supabase)
    return cont(mainMenu({
      data: visibility.data,
      afa: visibility.afa,
      airtime: visibility.airtime,
      resultsChecker: visibility.resultsChecker,
    }))
  }

  const name = input.trim()
  if (!name) return cont(afaEnterNamePrompt())

  await setSession(sessionId, { ...session, step: 'AFA_ENTER_CARD', afaFullName: name })
  return cont(afaEnterCardPrompt())
}

// ── AFA_ENTER_CARD ────────────────────────────────────────────────────────────
export async function handleAfaEnterCard(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'AFA_ENTER_NAME' })
    return cont(afaEnterNamePrompt())
  }

  const card = input.trim()
  if (!card) return cont(afaEnterCardPrompt())

  // Reject here rather than at fulfillment time — a malformed number typed
  // on a USSD keypad (missing the GHA prefix, missing a dash) previously
  // only surfaced as a failed order after payment. Re-prompt instead.
  const normalizedCard = parseGhanaCardNumber(card)
  if (!normalizedCard) {
    return cont('Invalid Ghana Card number.\nUse the format:\nGHA-123456789-0\n\n0. Back')
  }

  await setSession(sessionId, { ...session, step: 'AFA_ENTER_LOCATION', afaGhCard: normalizedCard })
  return cont(afaEnterLocationPrompt())
}

// ── AFA_ENTER_LOCATION ────────────────────────────────────────────────────────
export async function handleAfaEnterLocation(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'AFA_ENTER_CARD' })
    return cont(afaEnterCardPrompt())
  }

  const location = input.trim()
  if (!location) return cont(afaEnterLocationPrompt())

  await setSession(sessionId, { ...session, step: 'AFA_ENTER_REGION', afaLocation: location })
  return cont(afaEnterRegionPrompt())
}

// ── AFA_ENTER_REGION ──────────────────────────────────────────────────────────
export async function handleAfaEnterRegion(
  input: string,
  sessionId: string,
  session: USSDSession,
  channel: UssdChannel = 'ussd'
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'AFA_ENTER_LOCATION' })
    return cont(afaEnterLocationPrompt())
  }

  const region = input.trim()
  if (!region) return cont(afaEnterRegionPrompt())

  // Fetch current AFA price
  const { data: priceRow } = await supabase
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .single()
  const price = priceRow ? Number(priceRow.price) : 50

  const localPhone = session.dialingPhone?.startsWith('+233')
    ? '0' + session.dialingPhone.slice(4)
    : session.dialingPhone ?? ''

  await setSession(sessionId, { ...session, step: 'AFA_CONFIRM_AFA', afaRegion: region, afaPrice: price })
  return cont(afaConfirmMenu(session.afaFullName!, session.afaGhCard!, price, channel === 'whatsapp' ? null : localPhone))
}

// ── AFA_CONFIRM_AFA ───────────────────────────────────────────────────────────
export async function handleAfaConfirm(
  input: string,
  sessionId: string,
  session: USSDSession,
  /** 'whatsapp' from the WhatsApp router: the gateway surface, and the session owner is the sender (sessionId). */
  channel: UssdChannel = 'ussd'
): Promise<UzoResponse> {
  if (input.trim() === '2') {
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return end('Registration cancelled.')
  }

  if (input.trim() !== '1') {
    const localPhone = session.dialingPhone?.startsWith('+233')
      ? '0' + session.dialingPhone.slice(4)
      : session.dialingPhone ?? ''
    return cont(afaConfirmMenu(session.afaFullName!, session.afaGhCard!, session.afaPrice!, channel === 'whatsapp' ? null : localPhone))
  }

  const { afaFullName, afaGhCard, afaLocation, afaRegion, afaPrice, dialingPhone } = session

  const { data: feeSettings } = await supabase
    .from("app_settings")
    .select("paystack_fee_percentage")
    .is("key", null)
    .single()
  const feePercent = (feeSettings?.paystack_fee_percentage ?? 3.0) / 100
  const price: UssdPrice = { hubtel: afaPrice!, paystack: afaPrice! + Math.round(afaPrice! * feePercent * 100) / 100 }
  // Resolved before the order is written: Hubtel's amount has no Paystack fee. The prompt always goes to the dialler
  // on the MTN provider (as today), so only an MTN dialler can go to Hubtel.
  const surface = ussdChargeSurface(channel)
  const verifiedPayer = isUssdHubtelPayer({ chargePhone: dialingPhone, ownerPhone: channel === 'whatsapp' ? sessionId : dialingPhone, provider: 'mtn' })
  const chargeAmount = await ussdOrderAmount(surface, verifiedPayer, price)

  const { data: order, error: orderErr } = await supabase
    .from("ussd_afa_orders")
    .insert([{
      dialing_phone: dialingPhone,
      full_name: afaFullName,
      gh_card_number: afaGhCard,
      location: afaLocation,
      region: afaRegion,
      occupation: 'Farmer',
      amount: chargeAmount,
      payment_status: 'pending',
      order_status: 'pending',
    }])
    .select("id")
    .single()

  if (orderErr || !order) {
    console.error("[USSD-AFA] Failed to create order:", orderErr)
    return end('Error creating order.\nPlease try again.')
  }

  const orderId = order.id
  const email = await resolveEmail(dialingPhone!)
  const localPhone = dialingPhone?.startsWith('+233') ? '0' + dialingPhone.slice(4) : dialingPhone ?? ''

  // End session immediately so the MoMo prompt pops up as a notification
  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await startUssdCharge({
        surface,
        verifiedPayer,
        price,
        written: chargeAmount,
        params: {
          email,
          phone: dialingPhone!,
          // WhatsApp sets this from the typed number. USSD stays on MTN as before.
          provider: (channel === 'whatsapp' ? session.paystackProvider ?? 'mtn' : 'mtn') as 'mtn' | 'vod' | 'tgo',
          reference: orderId,
          metadata: {
            source: 'ussd_afa',
            ussd_afa_order_id: orderId,
            full_name: afaFullName,
            gh_card_number: afaGhCard,
          },
        },
        reprice: guardedReprice(supabase, "ussd_afa_orders", orderId, {
          from: { amount: chargeAmount }, set: { amount: price.paystack }, guards: { payment_status: "pending" },
        }),
      })

      await supabase
        .from("ussd_afa_orders")
        .update({ paystack_reference: orderId, updated_at: new Date().toISOString() })
        .eq("id", orderId)

      // WhatsApp: Paystack wants an OTP. The reply has already closed the chat, so reopen it on SUBMIT_OTP for this
      // order under the sender (sessionId), or the customer can never pay. payment_status stays 'pending': the AFA
      // success handler accepts nothing else. USSD has no way to ask after the session ends (unchanged).
      if (status === 'send_otp' && channel === 'whatsapp') {
        await setWaSession(sessionId, { step: 'SUBMIT_OTP', dialingPhone, pendingOrderId: orderId, pendingOrderTable: 'ussd_afa_orders' })
        await sendWhatsAppText(sessionId, `Your provider requires a one-time code to complete this payment.\n\nReply here with the OTP you received.\n\n0. Cancel`)
      } else if (status === 'send_otp') {
        // USSD can't ask once the session has ended: as bundles do, park the order for the redial and tell the customer.
        const { error: otpErr } = await supabase
          .from("ussd_afa_orders")
          .update({ payment_status: 'otp_required', updated_at: new Date().toISOString() })
          .eq("id", orderId)
          .eq("payment_status", "pending")
        if (otpErr) {
          // A refused write leaves nothing for a redial to find, so no SMS sends the customer looking for it.
          console.error("[USSD-AFA] Could not mark OTP required for order:", orderId, otpErr.code ?? "unknown")
        } else {
          sendSMS({ phone: dialingPhone!, message: SMSTemplates.ussdOtpRequired(), type: 'otp_required', reference: orderId }).catch(() => {})
        }
      }

      console.log("[USSD-AFA] ✓ MoMo charge initiated for AFA order:", orderId)
    } catch (err) {
      console.error("[USSD-AFA] Charge failed:", err)
      await supabase
        .from("ussd_afa_orders")
        .update({ payment_status: 'failed', order_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  return end(
    `MoMo authorization has been sent to your number (${localPhone}). AFA registration takes 12hrs to 24hrs to reflect, so please have patience.`
  )
}
