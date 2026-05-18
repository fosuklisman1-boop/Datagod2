import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import { cont, end, mainMenu, afaEnterNamePrompt, afaEnterCardPrompt, afaEnterLocationPrompt, afaEnterRegionPrompt, afaConfirmMenu } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { chargeMobileMoney } from "../../paystack"

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
    return cont(mainMenu())
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

  await setSession(sessionId, { ...session, step: 'AFA_ENTER_LOCATION', afaGhCard: card })
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
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'AFA_ENTER_LOCATION' })
    return cont(afaEnterLocationPrompt())
  }

  const region = input.trim()
  if (!region) return cont(afaEnterRegionPrompt())

  // Fetch AFA base price and Paystack fee together
  const [{ data: priceRow }, { data: feeRow }] = await Promise.all([
    supabase.from("afa_registration_prices").select("price").eq("is_active", true).single(),
    supabase.from("app_settings").select("paystack_fee_percentage").single(),
  ])
  const basePrice = priceRow ? Number(priceRow.price) : 50
  const feePercent = (feeRow?.paystack_fee_percentage ?? 3.0) / 100
  const chargeAmount = basePrice + Math.round(basePrice * feePercent * 100) / 100

  const localPhone = session.dialingPhone?.startsWith('+233')
    ? '0' + session.dialingPhone.slice(4)
    : session.dialingPhone ?? ''

  await setSession(sessionId, { ...session, step: 'AFA_CONFIRM_AFA', afaRegion: region, afaPrice: chargeAmount })
  return cont(afaConfirmMenu(session.afaFullName!, session.afaGhCard!, chargeAmount, localPhone))
}

// ── AFA_CONFIRM_AFA ───────────────────────────────────────────────────────────
export async function handleAfaConfirm(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '2') {
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return end('Registration cancelled.')
  }

  if (input.trim() !== '1') {
    const localPhone = session.dialingPhone?.startsWith('+233')
      ? '0' + session.dialingPhone.slice(4)
      : session.dialingPhone ?? ''
    return cont(afaConfirmMenu(session.afaFullName!, session.afaGhCard!, session.afaPrice!, localPhone))
  }

  const { afaFullName, afaGhCard, afaLocation, afaRegion, afaPrice, dialingPhone } = session

  // afaPrice is fee-inclusive (set in handleAfaEnterRegion)
  const { data: order, error: orderErr } = await supabase
    .from("ussd_afa_orders")
    .insert([{
      dialing_phone: dialingPhone,
      full_name: afaFullName,
      gh_card_number: afaGhCard,
      location: afaLocation,
      region: afaRegion,
      occupation: 'Farmer',
      amount: afaPrice,
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
      await chargeMobileMoney({
        email,
        amount: afaPrice!,
        phone: dialingPhone!,
        provider: 'mtn',
        reference: orderId,
        metadata: {
          source: 'ussd_afa',
          ussd_afa_order_id: orderId,
          full_name: afaFullName,
          gh_card_number: afaGhCard,
        },
      })

      await supabase
        .from("ussd_afa_orders")
        .update({ paystack_reference: orderId, updated_at: new Date().toISOString() })
        .eq("id", orderId)

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
