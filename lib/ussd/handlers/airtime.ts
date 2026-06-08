import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession } from "../types"
import {
  cont, end, mainMenu,
  airtimeRecipientPrompt, airtimeNetworkMenu, airtimeAmountPrompt,
  airtimeConfirmMenu, airtimePaymentMethodMenu,
} from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { resolveDialer } from "../resolve-dialer"
import { chargeMobileMoney } from "../../paystack"
import { paystackProviderFromPhone } from "../paystack-provider"
import { secureReference } from "../../secure-random"
import { sendSMS, SMSTemplates } from "../../sms-service"
import {
  detectAirtimeNetwork, isAirtimeEnabled, getAirtimeLimits,
  airtimeBaseFeeRate, splitInclusive,
} from "../../airtime-pricing"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function toLocal(phone: string): string {
  if (phone.startsWith("+233")) return "0" + phone.slice(4)
  if (phone.startsWith("233")) return "0" + phone.slice(3)
  return phone
}

async function dialerFeeRate(network: string, dialerRole?: string): Promise<number> {
  const isDealer = dialerRole === "dealer" || dialerRole === "sub_agent"
  return airtimeBaseFeeRate(network, isDealer)
}

// ── AIRTIME_ENTER_RECIPIENT ───────────────────────────────────────────────────
export async function handleAirtimeEnterRecipient(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { step: "MAIN", dialingPhone: session.dialingPhone })
    return cont(mainMenu())
  }

  const raw = input.trim().replace(/\s+/g, "")
  const local = toLocal(raw)
  if (!/^0[0-9]{9}$/.test(local)) {
    return cont("Invalid number.\n" + airtimeRecipientPrompt())
  }

  const network = detectAirtimeNetwork(local)
  if (!network) {
    // Unknown prefix — ask the caller to pick the recipient's network.
    await setSession(sessionId, { ...session, step: "AIRTIME_SELECT_NETWORK", airtimeRecipient: local })
    return cont(airtimeNetworkMenu())
  }

  if (!(await isAirtimeEnabled(network))) {
    return cont(`${network} airtime unavailable.\n` + airtimeRecipientPrompt())
  }

  const { min, max } = await getAirtimeLimits()
  await setSession(sessionId, { ...session, step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network })
  return cont(airtimeAmountPrompt(network, min, max))
}

// ── AIRTIME_SELECT_NETWORK (fallback when prefix unknown) ─────────────────────
export async function handleAirtimeSelectNetwork(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "AIRTIME_ENTER_RECIPIENT" })
    return cont(airtimeRecipientPrompt())
  }

  const map: Record<string, "MTN" | "Telecel" | "AT"> = { "1": "MTN", "2": "Telecel", "3": "AT" }
  const network = map[input.trim()]
  if (!network) return cont(airtimeNetworkMenu())

  if (!(await isAirtimeEnabled(network))) {
    return cont(`${network} airtime unavailable.\n` + airtimeNetworkMenu())
  }

  const { min, max } = await getAirtimeLimits()
  await setSession(sessionId, { ...session, step: "AIRTIME_ENTER_AMOUNT", airtimeNetwork: network })
  return cont(airtimeAmountPrompt(network, min, max))
}

// ── AIRTIME_ENTER_AMOUNT ──────────────────────────────────────────────────────
export async function handleAirtimeEnterAmount(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "AIRTIME_ENTER_RECIPIENT" })
    return cont(airtimeRecipientPrompt())
  }

  const amount = parseFloat(input.trim())
  const network = session.airtimeNetwork!
  const { min, max } = await getAirtimeLimits()
  if (isNaN(amount) || amount < min || amount > max) {
    return cont(`Enter a valid amount.\n` + airtimeAmountPrompt(network, min, max))
  }

  const dialer = await resolveDialer(session.dialingPhone ?? "")
  const rate = await dialerFeeRate(network, dialer.role)
  const { fee, toDeliver } = splitInclusive(amount, rate)

  await setSession(sessionId, {
    ...session,
    step: "AIRTIME_CONFIRM",
    airtimeAmount: amount,
    airtimeFee: fee,
    airtimeToDeliver: toDeliver,
    userId: dialer.userId,
    walletBalance: dialer.balance,
  })

  return cont(airtimeConfirmMenu(network, session.airtimeRecipient!, amount, toDeliver, session.dialingPhone!))
}

// ── AIRTIME_CONFIRM ───────────────────────────────────────────────────────────
export async function handleAirtimeConfirm(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === "2") {
    await setSession(sessionId, { step: "MAIN", dialingPhone: session.dialingPhone })
    return end("Order cancelled.")
  }
  if (input.trim() !== "1") {
    return cont(airtimeConfirmMenu(
      session.airtimeNetwork!, session.airtimeRecipient!,
      session.airtimeAmount!, session.airtimeToDeliver!, session.dialingPhone!
    ))
  }

  const network = session.airtimeNetwork!
  const dialingPhone = session.dialingPhone!

  // Re-verify settings server-side (stale-session guard)
  if (!(await isAirtimeEnabled(network))) {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end(`${network} airtime is no longer available.`)
  }
  const { min, max } = await getAirtimeLimits()
  const amount = session.airtimeAmount!
  if (amount < min || amount > max) {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end(`Amount must be GHS ${min}-${max}. Please restart.`)
  }

  const dialer = await resolveDialer(dialingPhone)
  const rate = await dialerFeeRate(network, dialer.role)
  const { fee, toDeliver } = splitInclusive(amount, rate)

  const provider = paystackProviderFromPhone(dialingPhone)
  const walletEligible = dialer.userId && dialer.balance !== undefined && dialer.balance >= amount
  if (!walletEligible && !provider) {
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Payment not available for your number.")
  }

  const referenceCode = secureReference("AT", 2, 3)
  const { data: order, error: orderErr } = await supabase
    .from("airtime_orders")
    .insert([{
      reference_code: referenceCode,
      network,
      beneficiary_phone: session.airtimeRecipient!,
      airtime_amount: toDeliver,
      fee_amount: fee,
      total_paid: amount,
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: dialer.userId ?? null,
      shop_id: null,
      merchant_commission: 0,
      customer_name: "USSD Customer",
      customer_email: dialer.email ?? null,
      dialing_phone: dialingPhone,
      channel: "ussd",
    }])
    .select("id")
    .single()

  if (orderErr || !order) {
    console.error("[USSD-AIRTIME] Failed to create order:", orderErr)
    return end("Error creating order.\nPlease try again.")
  }

  if (walletEligible) {
    await setSession(sessionId, {
      ...session,
      step: "AIRTIME_PAYMENT_METHOD",
      airtimeFee: fee,
      airtimeToDeliver: toDeliver,
      userId: dialer.userId,
      walletBalance: dialer.balance,
      pendingOrderId: order.id,
      pendingOrderTable: "airtime_orders",
    })
    return cont(airtimePaymentMethodMenu(amount, dialer.balance!))
  }

  await setSession(sessionId, {
    ...session,
    airtimeFee: fee,
    airtimeToDeliver: toDeliver,
    pendingOrderId: order.id,
    pendingOrderTable: "airtime_orders",
  })
  return chargeAirtimeMomo(sessionId, session, order.id, amount, provider!)
}

// ── AIRTIME_PAYMENT_METHOD ────────────────────────────────────────────────────
export async function handleAirtimePaymentMethod(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const orderId = session.pendingOrderId!
  const amount = session.airtimeAmount!
  const dialingPhone = session.dialingPhone!

  if (input.trim() === "0") {
    await supabase.from("airtime_orders")
      .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
      .eq("id", orderId)
    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Order cancelled.")
  }

  if (input.trim() === "2") {
    const provider = paystackProviderFromPhone(dialingPhone)
    if (!provider) return end("Payment not available for your number.")
    return chargeAirtimeMomo(sessionId, session, orderId, amount, provider)
  }

  if (input.trim() === "1") {
    const userId = session.userId!
    const { data: walletRow } = await supabase.from("wallets").select("balance").eq("user_id", userId).maybeSingle()
    const balance = walletRow ? Number(walletRow.balance) : 0
    if (balance < amount) {
      return cont(`Insufficient balance.\nWallet: GHS ${balance.toFixed(2)}\nNeeded: GHS ${amount.toFixed(2)}\n\n2. Pay via MoMo\n0. Cancel`)
    }

    const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", { p_user_id: userId, p_amount: amount })
    if (deductError || !deductResult || deductResult.length === 0) {
      return cont(`Insufficient balance.\nWallet: GHS ${balance.toFixed(2)}\nNeeded: GHS ${amount.toFixed(2)}\n\n2. Pay via MoMo\n0. Cancel`)
    }
    const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

    await supabase.from("airtime_orders")
      .update({ payment_status: "completed", status: "pending", updated_at: new Date().toISOString() })
      .eq("id", orderId)

    try {
      await supabase.from("transactions").insert([{
        user_id: userId,
        type: "debit",
        source: "airtime_purchase",
        amount,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: `Airtime: ${session.airtimeNetwork} GHS ${session.airtimeToDeliver} to ${session.airtimeRecipient}`,
        reference_id: orderId,
        status: "completed",
        created_at: new Date().toISOString(),
      }])
    } catch (txErr) {
      console.warn("[USSD-AIRTIME] Transaction insert failed (non-fatal):", txErr)
    }

    after(async () => {
      try {
        await sendSMS({
          phone: session.airtimeRecipient!,
          message: SMSTemplates.ussdAirtimePaymentReceived(
            session.airtimeToDeliver!.toFixed(2), session.airtimeNetwork!, session.airtimeRecipient!
          ),
          type: "airtime_order_created",
          reference: orderId,
        })
      } catch (smsErr) {
        console.warn("[USSD-AIRTIME] Wallet airtime SMS failed:", smsErr)
      }
    })

    await setSession(sessionId, { step: "MAIN", dialingPhone })
    return end("Payment successful.\nAirtime will reflect\nshortly.")
  }

  return cont(airtimePaymentMethodMenu(amount, session.walletBalance ?? 0))
}

// Fires the MoMo prompt and ends the session. Webhook completes on charge.success.
async function chargeAirtimeMomo(
  sessionId: string,
  session: USSDSession,
  orderId: string,
  amount: number,
  provider: "mtn" | "vod" | "tgo"
): Promise<UzoResponse> {
  const dialingPhone = session.dialingPhone!
  const localDialing = toLocal(dialingPhone)
  const email = await resolveEmail(dialingPhone)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount,
        phone: dialingPhone,
        provider,
        reference: orderId,
        metadata: {
          source: "ussd_airtime",
          airtime_order_id: orderId,
          recipient_phone: session.airtimeRecipient,
          network: session.airtimeNetwork,
        },
      })
      try {
        await supabase.from("payment_attempts").insert({
          reference: orderId, amount, email,
          status: "pending", payment_type: "ussd_airtime", order_id: orderId,
        })
      } catch (paErr) {
        console.warn("[USSD-AIRTIME] payment_attempts insert failed (non-fatal):", paErr)
      }
      console.log("[USSD-AIRTIME] ✓ Charge initiated:", orderId, "status:", status)
      if (status === "send_otp") {
        await supabase.from("airtime_orders")
          .update({ payment_status: "otp_required", updated_at: new Date().toISOString() })
          .eq("id", orderId)
        sendSMS({ phone: dialingPhone, message: SMSTemplates.ussdOtpRequired(), type: "otp_required", reference: orderId }).catch(() => {})
      }
    } catch (err) {
      console.error("[USSD-AIRTIME] Charge failed:", err)
      await supabase.from("airtime_orders")
        .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  await setSession(sessionId, { step: "MAIN", dialingPhone })
  return end(`MoMo prompt sent to ${localDialing}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`)
}
