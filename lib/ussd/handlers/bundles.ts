import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDSession, BundleOption } from "../types"
import { effectivePrice, getCustomPrices, NO_CUSTOM_PRICES, MSG_PRICES_UNAVAILABLE, ownerSaving } from "@/lib/pricing/package-price"
import { marginsValid, parentProfitFromCatalog, shopOwnerPricing } from "@/lib/shop-commerce/pricing"
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentMethodMenu, mainMenu, waWalletShort } from "../menus"
import { networkNickname } from "../network-labels"
import { setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { liveWalletBalance } from "../wallet-balance"
import { chargeMobileMoney, submitOtp } from "../../paystack"
import { paystackProviderFromPhone } from "../paystack-provider"
import { fulfillUssdOrder } from "../fulfill"
import { sendSMS, SMSTemplates } from "../../sms-service"
import { sendWhatsAppText } from "../../whatsapp-bot/send"
import { getJoinCommunityLink } from "../../app-settings"
import { validateNetworkPrefix } from "../../phone-format"
import { getPrefixValidationConfig } from "../../network-prefix-config"
import { isRecipientBlocked, RECIPIENT_BLOCKED_PROMPT } from "@/lib/mtn-providers/customer-verification"
import { getUssdServiceVisibility } from "../../ussd-service-visibility"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const PAGE_SIZE = 5

const NETWORK_OPTIONS: Record<string, { dbName: string; paystackProvider: 'mtn' | 'vod' | 'tgo' }> = {
  '1': { dbName: 'MTN', paystackProvider: 'mtn' },
  '2': { dbName: 'Telecel', paystackProvider: 'vod' },
  '3': { dbName: 'AT-iShare', paystackProvider: 'tgo' },
  '4': { dbName: 'AT-BigTime', paystackProvider: 'tgo' },
}

export async function fetchBundles(
  network: string,
  page: number,
  priceTier: string,
  parentShopId?: string,
  userId?: string
): Promise<{ bundles: BundleOption[]; total: number }> {
  // Sub-agents see only packages their parent has catalogued, at parent_price
  if (priceTier === 'sub_agent' && parentShopId) {
    const { data, count } = await supabase
      .from("sub_agent_catalog")
      .select("package_id, parent_price, packages!inner(id, size, network, is_available)", { count: 'exact' })
      .eq("shop_id", parentShopId)
      .eq("packages.network", network)
      .eq("packages.is_available", true)
      .order("parent_price", { ascending: true })
      .order("package_id", { ascending: true })
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
    .eq("is_available", true)
    .order("price", { ascending: true })
    .order("id", { ascending: true })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  // Display: a failed read shows role prices; handleConfirm re-prices and refuses on failure.
  const custom = await getCustomPrices(supabase, userId).catch(() => NO_CUSTOM_PRICES)
  const bundles: BundleOption[] = (data ?? []).map((row: any) => ({
    id: row.id,
    size: row.size,
    price: effectivePrice(row, priceTier === 'dealer', custom),
  }))

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
    const visibility = await getUssdServiceVisibility(supabase)
    return cont(mainMenu({
      data: visibility.data,
      afa: visibility.afa,
      airtime: visibility.airtime,
      resultsChecker: visibility.resultsChecker,
    }))
  }

  const net = NETWORK_OPTIONS[input.trim()]
  if (!net) return cont(networkMenu())

  // Resolve effective price tier from user's account role
  const dialingPhone = session.dialingPhone ?? ''
  const localPhone = dialingPhone.startsWith('+233') ? '0' + dialingPhone.slice(4)
    : dialingPhone.startsWith('233') ? '0' + dialingPhone.slice(3)
    : dialingPhone

  const [{ data: userRow }, { data: settingsRow }, { data: mtnProviderRow }] = await Promise.all([
    supabase.from("users").select("id, role").eq("phone_number", localPhone).maybeSingle(),
    supabase.from("app_settings").select("ussd_price_tier").is("key", null).single(),
    net.dbName === 'MTN'
      ? supabase.from("admin_settings").select("value").eq("key", "mtn_provider_selection").maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const mtnWhitelistActive = net.dbName === 'MTN' &&
    ['xpress', 'codecraft'].includes(mtnProviderRow?.value?.provider ?? '')

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

  const { bundles, total } = await fetchBundles(net.dbName, 0, effectivePriceTier, subAgentParentShopId, userRow?.id)
  if (bundles.length === 0) {
    return cont(`No ${networkNickname(net.dbName)} packages available.\n\n${networkMenu()}`)
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
    mtnWhitelistActive,
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
  const offset = page * PAGE_SIZE

  // Re-fetch the current page before any routing — both the moreIndex check and
  // the bundle selection must agree on the same bundle count. Trusting session.bundleCache
  // causes a mismatch when the cache is stale (page advances but cache holds old data).
  const { bundles, total } = await fetchBundles(
    session.network!, page, session.effectivePriceTier ?? 'regular', session.subAgentParentShopId, session.userId
  )

  const moreIndex = offset + bundles.length + 1
  const chosen = parseInt(input.trim(), 10)

  if (chosen === moreIndex && offset + bundles.length < total) {
    const nextPage = page + 1
    const { bundles: nextBundles, total: newTotal } = await fetchBundles(session.network!, nextPage, session.effectivePriceTier ?? 'regular', session.subAgentParentShopId, session.userId)
    await setSession(sessionId, {
      ...session,
      bundlePage: nextPage,
      bundleCache: nextBundles,
      bundleTotal: newTotal,
    })
    return cont(bundleMenu(nextBundles, nextPage, newTotal))
  }

  const bundleIndex = chosen - offset - 1
  const selected = bundles[bundleIndex]
  if (!selected) return cont(bundleMenu(bundles, page, total))

  await setSession(sessionId, {
    ...session,
    step: 'ENTER_RECIPIENT',
    bundleCache: bundles,
    bundleTotal: total,
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

  // Network↔prefix validation (hard block; admin-toggleable).
  const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
  if (prefixCheckEnabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefixMap)
    if (!check.ok) {
      return cont(`${check.message}\n\nEnter recipient number:\n0. Back`)
    }
  }

  // MTN number verification hard block (admin toggle): ask for another number. Outages never block.
  if (await isRecipientBlocked(session.network, local)) {
    return cont(RECIPIENT_BLOCKED_PROMPT)
  }

  await setSession(sessionId, { ...session, step: 'CONFIRM', recipientPhone: local })

  return cont(confirmMenu(
    networkNickname(session.network!),
    session.bundleSize!,
    session.bundlePrice!,
    local,
    session.dialingPhone!,
    session.mtnWhitelistActive === true
  ))
}

// ── CONFIRM ───────────────────────────────────────────────────────────────────
export async function handleConfirm(
  input: string,
  sessionId: string,
  session: USSDSession,
  channel: 'ussd' | 'whatsapp' = 'ussd',
  /**
   * WhatsApp "Pay via Wallet": if the wallet cannot cover the verified price, create nothing and return
   * `walletShort` (the router asks for a MoMo number) instead of charging `dialingPhone`, the sender's own number
   * there. USSD never passes it.
   */
  opts: { walletOnly?: boolean } = {}
): Promise<UzoResponse> {
  if (input.trim() === '2') {
    // Cancel
    await setSession(sessionId, { step: 'MAIN', dialingPhone: session.dialingPhone })
    return end('Order cancelled.')
  }

  if (input.trim() !== '1') {
    return cont(confirmMenu(
      networkNickname(session.network!),
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!,
      session.mtnWhitelistActive === true
    ))
  }

  // 1 = Confirm payment
  const { network, paystackProvider, bundleId, bundleSize, bundlePrice, recipientPhone, dialingPhone } = session

  // Validate price still matches DB (security: prevent stale session attacks)
  const { data: pkg } = await supabase
    .from("packages")
    .select("id, price, dealer_price, is_available")
    .eq("id", bundleId!)
    .single()

  if (!pkg || !pkg.is_available) {
    await setSession(sessionId, { step: 'MAIN', dialingPhone })
    return end('Package no longer available. Please try again.')
  }

  const { data: feeSettings } = await supabase
    .from("app_settings")
    .select("paystack_fee_percentage")
    .is("key", null)
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
    if (catalogRow) {
      // The sub-agent pays the parent's catalog price (their own custom prices never apply). The parent earns
      // wholesale margin + their saving (parent role price - parent cost), as on the storefront.
      const wholesale = Number(catalogRow.wholesale_margin)
      if (!marginsValid(wholesale)) {
        await setSession(sessionId, { step: 'MAIN', dialingPhone })
        return end('Package no longer available. Please try again.')
      }
      let parent
      try {
        parent = await shopOwnerPricing(session.subAgentParentShopId)
      } catch {
        await setSession(sessionId, { step: 'MAIN', dialingPhone })
        return end(MSG_PRICES_UNAVAILABLE)
      }
      parentProfitAmount = parentProfitFromCatalog(wholesale, ownerSaving(pkg, parent.isDealer, parent.custom))
    }
  } else {
    let custom
    try {
      custom = await getCustomPrices(supabase, session.userId)
    } catch {
      await setSession(sessionId, { step: 'MAIN', dialingPhone })
      return end(MSG_PRICES_UNAVAILABLE)
    }
    verifiedPrice = effectivePrice(pkg, priceTier === 'dealer', custom)
  }

  const fee = Math.round(verifiedPrice * feePercent * 100) / 100
  const chargeAmount = verifiedPrice + fee

  if (Math.abs(verifiedPrice - bundlePrice!) > 0.01) {
    await setSession(sessionId, { step: 'MAIN', dialingPhone })
    return end(`Price changed to GHS ${verifiedPrice.toFixed(2)}. Please restart your order.`)
  }

  // Same wallet test as the PAYMENT_METHOD detour below, made before any order exists. WhatsApp "Pay via Wallet"
  // (walletOnly) reads the LIVE wallet of the session's account (session.userId: the sender's own account or an
  // OTP-linked one; the debit uses that same id), so a balance spent since the menu never leaves a pending order row
  // behind; the Uzo path keeps the session's cached balance exactly as before.
  let walletBalance = session.walletBalance
  if (opts.walletOnly) walletBalance = await liveWalletBalance(session.userId)
  const walletEligible = !!session.userId && walletBalance !== undefined && walletBalance >= verifiedPrice
  if (opts.walletOnly && !walletEligible) return waWalletShort()

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

  if (walletEligible) {
    await setSession(sessionId, { ...session, step: 'PAYMENT_METHOD', pendingOrderId: orderId, ...(opts.walletOnly ? { walletBalance } : {}) })
    return cont(paymentMethodMenu(verifiedPrice, walletBalance!))
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
        if (channel === 'whatsapp') {
          // Unlike USSD (stateless per-dial, must redial to resume), WhatsApp's
          // session is keyed by phone number and stays addressable — reopen it
          // directly into SUBMIT_OTP and push a follow-up message, rather than
          // relying on the USSD-only redial-resume lookup in lib/ussd/router.ts.
          await setSession(dialingPhone!, { step: 'SUBMIT_OTP', dialingPhone, pendingOrderId: orderId })
          await sendWhatsAppText(dialingPhone!, `Your provider requires a one-time code to complete this payment.\n\nReply here with the OTP you received.\n\n0. Cancel`)
        } else {
          console.log("[USSD-CONFIRM] OTP required — user must redial to complete:", orderId)
          sendSMS({ phone: dialingPhone!, message: SMSTemplates.ussdOtpRequired(), type: 'otp_required', reference: orderId }).catch(() => {})
        }
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
  session: USSDSession,
  channel: 'ussd' | 'whatsapp' = 'ussd'
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
      .from("app_settings").select("paystack_fee_percentage").is("key", null).single()
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
          if (channel === 'whatsapp') {
            await setSession(dialingPhone!, { step: 'SUBMIT_OTP', dialingPhone, pendingOrderId: orderId })
            await sendWhatsAppText(dialingPhone!, `Your provider requires a one-time code to complete this payment.\n\nReply here with the OTP you received.\n\n0. Cancel`)
          } else {
            console.log("[USSD-PAYMENT_METHOD] OTP required — user must redial to complete:", orderId)
            sendSMS({ phone: dialingPhone!, message: SMSTemplates.ussdOtpRequired(), type: 'otp_required', reference: orderId }).catch(() => {})
          }
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
        const channelLink = await getJoinCommunityLink()
        await sendSMS({
          phone: recipientPhone!,
          message: SMSTemplates.ussdOrderConfirmed(bundleSize ?? '', network ?? '', channelLink),
          type: 'order_confirmation',
          reference: orderId,
        })
      } catch (smsErr) {
        console.warn("[USSD-WALLET] SMS failed:", smsErr)
      }
    })

    return end('Payment successful.\nYour package will reflect\nin a few minutes.')
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

  const otp = input.trim()
  const orderId = session.pendingOrderId!

  // Mark pending before closing session to prevent re-OTP prompt on quick redial
  await supabase
    .from("ussd_orders")
    .update({ payment_status: 'pending', updated_at: new Date().toISOString() })
    .eq("id", orderId)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await submitOtp(orderId, otp)
      console.log("[USSD-OTP] submitOtp status:", status, "order:", orderId)
      if (status === 'failed') {
        await supabase
          .from("ussd_orders")
          .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
          .eq("id", orderId)
      }
    } catch (err) {
      console.error("[USSD-OTP] submitOtp error:", err)
      await supabase
        .from("ussd_orders")
        .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  return end('Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment.')
}
