import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession, BundleOption } from "../types"
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentMethodMenu, mainMenu } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { chargeMobileMoney, submitOtp } from "../../paystack"
import { paystackProviderFromPhone } from "../paystack-provider"
import { fulfillUssdOrder } from "../fulfill"
import { sendSMS, SMSTemplates } from "../../sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAGE_SIZE = 5

const NETWORK_OPTIONS: Record<string, { dbName: string; paystackProvider: 'mtn' | 'vod' | 'tgo' }> = {
  '1': { dbName: 'MTN', paystackProvider: 'mtn' },
  '2': { dbName: 'Telecel', paystackProvider: 'vod' },
  '3': { dbName: 'AirtelTigo', paystackProvider: 'tgo' },
  '4': { dbName: 'AT-iShare', paystackProvider: 'tgo' },
}

async function fetchBundles(
  network: string,
  page: number,
  priceTier: string,
  parentShopId?: string
): Promise<{ bundles: BundleOption[]; total: number }> {
  // Sub-agents see only packages their parent has catalogued, at parent_price
  if (priceTier === 'sub_agent' && parentShopId) {
    const { data, count } = await supabase
      .from("sub_agent_catalog")
      .select("package_id, parent_price, packages!inner(id, size, network, active)", { count: 'exact' })
      .eq("shop_id", parentShopId)
      .eq("packages.network", network)
      .eq("packages.active", true)
      .order("parent_price", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    const bundles: BundleOption[] = (data ?? []).map((row: any) => ({
      id: row.packages.id,
      size: row.packages.size,
      price: Number(row.parent_price),
    }))

    return { bundles, total: count ?? 0 }
  }

  // Regular / dealer — query packages table directly
  const { data, count } = await supabase
    .from("packages")
    .select("id, size, price, dealer_price", { count: 'exact' })
    .eq("network", network)
    .eq("active", true)
    .order("price", { ascending: true })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  const bundles: BundleOption[] = (data ?? []).map((row: any) => {
    const useDealer = priceTier === 'dealer' && row.dealer_price && Number(row.dealer_price) > 0
    return {
      id: row.id,
      size: row.size,
      price: useDealer ? Number(row.dealer_price) : Number(row.price),
    }
  })

  return { bundles, total: count ?? 0 }
}

// ── SELECT_NETWORK ────────────────────────────────────────────────────────────
export async function handleSelectNetwork(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return cont(mainMenu())
  }

  const net = NETWORK_OPTIONS[input.trim()]
  if (!net) return cont(networkMenu())

  // Resolve effective price tier from user's account role
  const dialingPhone = session.dialingPhone ?? ''
  const localPhone = dialingPhone.startsWith('+233') ? '0' + dialingPhone.slice(4)
    : dialingPhone.startsWith('233') ? '0' + dialingPhone.slice(3)
    : dialingPhone

  const [{ data: userRow }, { data: settingsRow }] = await Promise.all([
    supabase.from("users").select("id, role").eq("phone_number", localPhone).maybeSingle(),
    supabase.from("app_settings").select("ussd_price_tier").single(),
  ])

  let effectivePriceTier: string = settingsRow?.ussd_price_tier ?? 'regular'
  let subAgentParentShopId: string | undefined
  let walletBalance: number | undefined

  if (userRow) {
    if (userRow.role === 'dealer') {
      effectivePriceTier = 'dealer'
      const { data: walletRow } = await supabase
        .from("wallets").select("balance").eq("user_id", userRow.id).maybeSingle()
      walletBalance = walletRow ? Number(walletRow.balance) : undefined
    } else if (userRow.role === 'sub_agent') {
      const [{ data: shopRow }, { data: walletRow }] = await Promise.all([
        supabase.from("user_shops").select("parent_shop_id").eq("user_id", userRow.id).not("parent_shop_id", "is", null).maybeSingle(),
        supabase.from("wallets").select("balance").eq("user_id", userRow.id).maybeSingle(),
      ])
      walletBalance = walletRow ? Number(walletRow.balance) : undefined
      if (shopRow?.parent_shop_id) {
        effectivePriceTier = 'sub_agent'
        subAgentParentShopId = shopRow.parent_shop_id
      } else {
        effectivePriceTier = 'regular'
      }
    } else {
      effectivePriceTier = 'regular'
      const { data: walletRow } = await supabase
        .from("wallets").select("balance").eq("user_id", userRow.id).maybeSingle()
      walletBalance = walletRow ? Number(walletRow.balance) : undefined
    }
  }

  const { bundles, total } = await fetchBundles(net.dbName, 0, effectivePriceTier, subAgentParentShopId)
  if (bundles.length === 0) {
    return cont(`No ${net.dbName} bundles available.\n\n${networkMenu()}`)
  }

  const paystackProvider = paystackProviderFromPhone(dialingPhone) ?? net.paystackProvider

  await setSession(sessionId, {
    ...session,
    step: 'SELECT_BUNDLE',
    network: net.dbName,
    paystackProvider,
    effectivePriceTier,
    subAgentParentShopId,
    userId: userRow?.id,
    walletBalance,
    bundlePage: 0,
    bundleCache: bundles,
    bundleTotal: total,
  })

  return cont(bundleMenu(bundles, 0, total))
}

// ── SELECT_BUNDLE ─────────────────────────────────────────────────────────────
export async function handleSelectBundle(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone: session.dialingPhone })
    return cont(networkMenu())
  }

  const page = session.bundlePage ?? 0
  const bundles = session.bundleCache ?? []
  const total = session.bundleTotal ?? bundles.length
  const offset = page * PAGE_SIZE

  // "More" option is the item right after the last bundle on this page
  const moreIndex = offset + bundles.length + 1
  const chosen = parseInt(input.trim(), 10)

  if (chosen === moreIndex && offset + bundles.length < total) {
    // Load next page
    const nextPage = page + 1
    const { bundles: nextBundles, total: newTotal } = await fetchBundles(session.network!, nextPage, session.effectivePriceTier ?? 'regular', session.subAgentParentShopId)
    await setSession(sessionId, {
      ...session,
      bundlePage: nextPage,
      bundleCache: nextBundles,
      bundleTotal: newTotal,
    })
    return cont(bundleMenu(nextBundles, nextPage, newTotal))
  }

  // Map selection to bundle
  const bundleIndex = chosen - offset - 1
  const selected = bundles[bundleIndex]
  if (!selected) return cont(bundleMenu(bundles, page, total))

  await setSession(sessionId, {
    ...session,
    step: 'ENTER_RECIPIENT',
    bundleId: selected.id,
    bundleSize: selected.size,
    bundlePrice: selected.price,
  })

  return cont(recipientPrompt())
}

// ── ENTER_RECIPIENT ───────────────────────────────────────────────────────────
export async function handleEnterRecipient(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    const page = session.bundlePage ?? 0
    const bundles = session.bundleCache ?? []
    const total = session.bundleTotal ?? bundles.length
    await setSession(sessionId, { ...session, step: 'SELECT_BUNDLE' })
    return cont(bundleMenu(bundles, page, total))
  }

  // Basic Ghana phone validation
  const raw = input.trim().replace(/\s+/g, '')
  const local = raw.startsWith('+233') ? '0' + raw.slice(4)
    : raw.startsWith('233') ? '0' + raw.slice(3)
    : raw

  if (!/^0[0-9]{9}$/.test(local)) {
    return cont('Invalid number.\nEnter a valid Ghana\nphone number:\n\n0. Back')
  }

  await setSession(sessionId, { ...session, step: 'CONFIRM', recipientPhone: local })

  return cont(confirmMenu(
    session.network!,
    session.bundleSize!,
    session.bundlePrice!,
    local,
    session.dialingPhone!
  ))
}

// ── CONFIRM ───────────────────────────────────────────────────────────────────
export async function handleConfirm(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '2') {
    // Cancel
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return end('Order cancelled.')
  }

  if (input.trim() !== '1') {
    return cont(confirmMenu(
      session.network!,
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!
    ))
  }

  // 1 = Confirm payment
  const { network, paystackProvider, bundleId, bundleSize, bundlePrice, recipientPhone, dialingPhone } = session

  // Validate price still matches DB (security: prevent stale session attacks)
  const { data: pkg } = await supabase
    .from("packages")
    .select("price, dealer_price, active")
    .eq("id", bundleId!)
    .single()

  if (!pkg || !pkg.active) {
    await setSession(sessionId, { step: 'MAIN', dialingPhone })
    return end('Bundle no longer available. Please try again.')
  }

  const { data: feeSettings } = await supabase
    .from("app_settings")
    .select("paystack_fee_percentage")
    .single()
  const feePercent = (feeSettings?.paystack_fee_percentage ?? 3.0) / 100
  const priceTier = session.effectivePriceTier ?? 'regular'

  let verifiedPrice: number
  let parentProfitAmount: number | null = null

  if (priceTier === 'sub_agent' && session.subAgentParentShopId) {
    const { data: catalogRow } = await supabase
      .from("sub_agent_catalog")
      .select("parent_price, wholesale_margin")
      .eq("shop_id", session.subAgentParentShopId)
      .eq("package_id", bundleId!)
      .single()
    verifiedPrice = catalogRow ? Number(catalogRow.parent_price) : Number(pkg.price)
    parentProfitAmount = catalogRow ? Number(catalogRow.wholesale_margin) : null
  } else {
    const useDealer = priceTier === 'dealer' && pkg.dealer_price && Number(pkg.dealer_price) > 0
    verifiedPrice = useDealer ? Number(pkg.dealer_price) : Number(pkg.price)
  }

  const fee = Math.round(verifiedPrice * feePercent * 100) / 100
  const chargeAmount = verifiedPrice + fee

  if (Math.abs(verifiedPrice - bundlePrice!) > 0.01) {
    await setSession(sessionId, { step: 'MAIN', dialingPhone })
    return end(`Price changed to GHS ${verifiedPrice.toFixed(2)}. Please restart your order.`)
  }

  // Create pending order
  const { data: order, error: orderError } = await supabase
    .from("ussd_orders")
    .insert([{
      dialing_phone: dialingPhone,
      recipient_phone: recipientPhone,
      network,
      paystack_provider: paystackProvider,
      package_id: bundleId,
      package_size: bundleSize,
      amount: chargeAmount,
      price_tier: priceTier === 'sub_agent' ? 'sub_agent' : priceTier,
      parent_shop_id: session.subAgentParentShopId ?? null,
      parent_profit_amount: parentProfitAmount,
      shop_owner_id: session.userId ?? null,
      order_status: 'pending',
      payment_status: 'pending',
    }])
    .select("id")
    .single()

  if (orderError || !order) {
    console.error("[USSD-CONFIRM] Failed to create order:", orderError)
    return end('Error creating order. Please try again.')
  }

  const orderId = order.id
  const localDialing = dialingPhone!.startsWith('+233') ? '0' + dialingPhone!.slice(4) : dialingPhone

  if (session.userId && session.walletBalance !== undefined && session.walletBalance >= verifiedPrice) {
    await setSession(sessionId, { ...session, step: 'PAYMENT_METHOD', pendingOrderId: orderId })
    return cont(paymentMethodMenu(verifiedPrice, session.walletBalance))
  }

  const email = await resolveEmail(dialingPhone!)
  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount: chargeAmount,
        phone: dialingPhone!,
        provider: paystackProvider as 'mtn' | 'vod' | 'tgo',
        reference: orderId,
        metadata: { source: 'ussd', ussd_order_id: orderId, recipient_phone: recipientPhone, network, package_size: bundleSize },
      })
      try {
        await supabase.from("payment_attempts").insert({ reference: orderId, amount: verifiedPrice, email, status: 'pending', payment_type: 'ussd', order_id: orderId })
      } catch (paErr) {
        console.warn("[USSD-CONFIRM] payment_attempts insert failed (non-fatal):", paErr)
      }
      await supabase.from("ussd_orders").update({ paystack_reference: orderId, updated_at: new Date().toISOString() }).eq("id", orderId)
      console.log("[USSD-CONFIRM] ✓ Charge initiated for order:", orderId, "status:", status)
      if (status === 'send_otp') {
        await supabase.from("ussd_orders").update({ payment_status: 'otp_required', updated_at: new Date().toISOString() }).eq("id", orderId)
        console.log("[USSD-CONFIRM] OTP required — user must redial to complete:", orderId)
      }
    } catch (err) {
      console.error("[USSD-CONFIRM] Charge failed:", err)
      await supabase.from("ussd_orders").update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() }).eq("id", orderId)
    }
  })

  return end(
    `MoMo prompt sent to ${localDialing}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`
  )
}

// ── PAYMENT_METHOD ────────────────────────────────────────────────────────────
export async function handlePaymentMethod(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  const orderId = session.pendingOrderId!
  const verifiedPrice = session.bundlePrice!
  const { network, paystackProvider, recipientPhone, dialingPhone, userId, bundleSize } = session
  const localDialing = dialingPhone!.startsWith('+233') ? '0' + dialingPhone!.slice(4) : dialingPhone!

  if (input.trim() === '0') {
    await supabase
      .from("ussd_orders")
      .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq("id", orderId)
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return end('Order cancelled.')
  }

  if (input.trim() === '2') {
    const { data: feeSettings } = await supabase
      .from("app_settings").select("paystack_fee_percentage").single()
    const feePercent = (feeSettings?.paystack_fee_percentage ?? 3.0) / 100
    const fee = Math.round(verifiedPrice * feePercent * 100) / 100
    const chargeAmount = verifiedPrice + fee

    const email = await resolveEmail(dialingPhone!)
    after(async () => {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const { status } = await chargeMobileMoney({
          email,
          amount: chargeAmount,
          phone: dialingPhone!,
          provider: paystackProvider as 'mtn' | 'vod' | 'tgo',
          reference: orderId,
          metadata: { source: 'ussd', ussd_order_id: orderId, recipient_phone: recipientPhone, network, package_size: bundleSize },
        })
        try {
          await supabase.from("payment_attempts").insert({ reference: orderId, amount: verifiedPrice, email, status: 'pending', payment_type: 'ussd', order_id: orderId })
        } catch (paErr) {
          console.warn("[USSD-PAYMENT_METHOD] payment_attempts insert failed:", paErr)
        }
        await supabase.from("ussd_orders").update({ paystack_reference: orderId, updated_at: new Date().toISOString() }).eq("id", orderId)
        console.log("[USSD-PAYMENT_METHOD] ✓ MoMo charge initiated:", orderId, status)
        if (status === 'send_otp') {
          await supabase.from("ussd_orders").update({ payment_status: 'otp_required', updated_at: new Date().toISOString() }).eq("id", orderId)
          console.log("[USSD-PAYMENT_METHOD] OTP required — user must redial to complete:", orderId)
        }
      } catch (err) {
        console.error("[USSD-PAYMENT_METHOD] MoMo charge failed:", err)
        await supabase.from("ussd_orders").update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() }).eq("id", orderId)
      }
    })
    return end(
      `MoMo prompt has been sent to your number (${localDialing}). Please approve to complete your order.`
    )
  }

  if (input.trim() === '1') {
    const { data: walletRow } = await supabase
      .from("wallets").select("balance").eq("user_id", userId!).maybeSingle()
    const currentBalance = walletRow ? Number(walletRow.balance) : 0

    if (currentBalance < verifiedPrice) {
      return cont(
        `Insufficient balance.\nWallet: GHS ${currentBalance.toFixed(2)}\nNeeded: GHS ${verifiedPrice.toFixed(2)}\n\n2. Pay via MoMo\n0. Cancel`
      )
    }

    const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
      p_user_id: userId!,
      p_amount: verifiedPrice,
    })

    if (deductError || !deductResult || deductResult.length === 0) {
      return cont(
        `Insufficient balance.\nWallet: GHS ${currentBalance.toFixed(2)}\nNeeded: GHS ${verifiedPrice.toFixed(2)}\n\n2. Pay via MoMo\n0. Cancel`
      )
    }

    const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

    try {
      await supabase.from("transactions").insert([{
        user_id: userId,
        type: 'debit',
        source: 'ussd_data_purchase',
        amount: verifiedPrice,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: `USSD data purchase: ${network} ${bundleSize}`,
        reference_id: orderId,
        status: 'completed',
        created_at: new Date().toISOString(),
      }])
    } catch (txErr) {
      console.warn("[USSD-WALLET] Transaction insert failed (non-fatal):", txErr)
    }

    await supabase
      .from("ussd_orders")
      .update({ amount: verifiedPrice, payment_status: 'completed', order_status: 'processing', updated_at: new Date().toISOString() })
      .eq("id", orderId)

    // Credit parent shop profit if this is a sub-agent order
    if (session.subAgentParentShopId && session.walletBalance !== undefined) {
      const { data: orderRow } = await supabase
        .from("ussd_orders")
        .select("parent_shop_id, parent_profit_amount")
        .eq("id", orderId)
        .single()
      if (orderRow?.parent_shop_id && Number(orderRow.parent_profit_amount) > 0) {
        const { error: profitErr } = await supabase
          .from("shop_profits")
          .insert([{
            shop_id: orderRow.parent_shop_id,
            ussd_order_id: orderId,
            profit_amount: orderRow.parent_profit_amount,
            status: 'credited',
            created_at: new Date().toISOString(),
          }])
        if (profitErr) {
          console.error("[USSD-WALLET] Failed to credit parent profit:", profitErr)
        } else {
          console.log(`[USSD-WALLET] ✓ Parent profit credited: GHS ${orderRow.parent_profit_amount}`)
        }
      }
    }

    after(async () => {
      try {
        await fulfillUssdOrder(orderId, network!, recipientPhone!, bundleSize!)
      } catch (err) {
        console.error("[USSD-WALLET] Fulfillment failed:", err)
        await supabase
          .from("ussd_orders")
          .update({ order_status: 'failed', updated_at: new Date().toISOString() })
          .eq("id", orderId)
      }

      try {
        await sendSMS({
          phone: recipientPhone!,
          message: SMSTemplates.ussdOrderConfirmed(bundleSize, network),
          type: 'order_confirmation',
          reference: orderId,
        })
      } catch (smsErr) {
        console.warn("[USSD-WALLET] SMS failed:", smsErr)
      }
    })

    return end('Payment successful.\nYour bundle will reflect\nin a few minutes.')
  }

  return cont(paymentMethodMenu(verifiedPrice, session.walletBalance ?? 0))
}

// ── SUBMIT_OTP ────────────────────────────────────────────────────────────────
export async function handleSubmitOtp(
  input: string,
  _sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await supabase
      .from("ussd_orders")
      .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq("id", session.pendingOrderId)
    return end('Order cancelled.')
  }

  try {
    const { status } = await submitOtp(session.pendingOrderId!, input.trim())
    console.log("[USSD-OTP] submitOtp status:", status, "order:", session.pendingOrderId)

    if (status === 'send_otp') {
      return cont('Invalid OTP.\nTry again:\n\n0. Cancel')
    }

    if (status === 'failed') {
      await supabase
        .from("ussd_orders")
        .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", session.pendingOrderId)
      return end('OTP verification failed.\nPlease try again later.')
    }

    // OTP accepted — wait briefly for Paystack to dispatch the MoMo push
    await new Promise(r => setTimeout(r, 3000))
    await supabase
      .from("ussd_orders")
      .update({ payment_status: 'pending', updated_at: new Date().toISOString() })
      .eq("id", session.pendingOrderId)
    return end('OTP verified!\nCheck your phone for\na MoMo authorization\nprompt and approve\nto complete payment.')
  } catch (err) {
    console.error("[USSD-OTP] submitOtp error:", err)
    return cont('Error verifying OTP.\nTry again:\n\n0. Cancel')
  }
}
