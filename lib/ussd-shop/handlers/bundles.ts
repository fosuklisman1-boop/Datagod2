import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession, ShopBundleOption } from "../types"
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentSentMenu, otpMenu } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { sendSMS } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAGE_SIZE = 5

const PAYSTACK_PROVIDER: Record<string, 'mtn' | 'vod' | 'tgo'> = {
  'MTN':        'mtn',
  'Telecel':    'vod',
  'AirtelTigo': 'tgo',
  'AT-iShare':  'tgo',
}

async function fetchShopBundles(
  shopId: string,
  network: string,
  page: number,
  parentShopId?: string
): Promise<{ bundles: ShopBundleOption[]; total: number }> {
  if (parentShopId) {
    const { data, count } = await supabase
      .from("sub_agent_catalog")
      .select(
        "wholesale_margin, sub_agent_profit_margin, packages!inner(id, size, price, network, active)",
        { count: 'exact' }
      )
      .eq("shop_id", parentShopId)
      .eq("packages.network", network)
      .eq("packages.active", true)
      .eq("is_active", true)
      .order("price", { foreignTable: "packages", ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    const bundles: ShopBundleOption[] = (data ?? []).map((row: any) => ({
      id: row.packages.id,
      size: row.packages.size,
      price: Number(row.packages.price) + Number(row.wholesale_margin) + Number(row.sub_agent_profit_margin),
    }))

    return { bundles, total: count ?? 0 }
  }

  const { data, count } = await supabase
    .from("shop_packages")
    .select(
      "profit_margin, packages!inner(id, size, price, network, active)",
      { count: 'exact' }
    )
    .eq("shop_id", shopId)
    .eq("packages.network", network)
    .eq("packages.active", true)
    .eq("is_available", true)
    .order("price", { foreignTable: "packages", ascending: true })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  const bundles: ShopBundleOption[] = (data ?? []).map((row: any) => ({
    id: row.packages.id,
    size: row.packages.size,
    price: Number(row.packages.price) + Number(row.profit_margin),
  }))

  return { bundles, total: count ?? 0 }
}

function formatLocal(phone: string): string {
  if (phone.startsWith('+233')) return '0' + phone.slice(4)
  if (phone.startsWith('233')) return '0' + phone.slice(3)
  return phone
}

// ── SELECT_NETWORK ────────────────────────────────────────────────────────────
export async function handleSelectNetwork(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const networks = session.networks ?? []

  if (input.trim() === '0') {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone: session.dialingPhone })
    return cont('Enter shop code:\n\n0. Exit')
  }

  const idx = parseInt(input.trim(), 10) - 1
  const selectedNetwork = networks[idx]

  if (!selectedNetwork) {
    return cont(networkMenu(session.shopName!, networks))
  }

  const paystackProvider = PAYSTACK_PROVIDER[selectedNetwork] ?? null

  const { bundles, total } = await fetchShopBundles(session.shopId!, selectedNetwork, 0, session.parentShopId)

  if (bundles.length === 0) {
    return cont(`No ${selectedNetwork} bundles available.\n\n${networkMenu(session.shopName!, networks)}`)
  }

  await setSession(sessionId, {
    ...session,
    step: 'SELECT_BUNDLE',
    network: selectedNetwork,
    paystackProvider,
    bundlePage: 0,
    bundleCache: bundles,
    bundleTotal: total,
  })

  return cont(bundleMenu(session.shopName!, bundles, 0, total))
}

// ── SELECT_BUNDLE ─────────────────────────────────────────────────────────────
export async function handleSelectBundle(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'SELECT_NETWORK' })
    return cont(networkMenu(session.shopName!, session.networks ?? []))
  }

  const page = session.bundlePage ?? 0
  const bundles = session.bundleCache ?? []
  const total = session.bundleTotal ?? bundles.length
  const offset = page * PAGE_SIZE

  const moreIndex = offset + bundles.length + 1
  const chosen = parseInt(input.trim(), 10)

  if (chosen === moreIndex && offset + bundles.length < total) {
    const nextPage = page + 1
    const { bundles: nextBundles, total: newTotal } = await fetchShopBundles(session.shopId!, session.network!, nextPage, session.parentShopId)
    await setSession(sessionId, { ...session, bundlePage: nextPage, bundleCache: nextBundles, bundleTotal: newTotal })
    return cont(bundleMenu(session.shopName!, nextBundles, nextPage, newTotal))
  }

  const bundleIndex = chosen - offset - 1
  const selected = bundles[bundleIndex]
  if (!selected) return cont(bundleMenu(session.shopName!, bundles, page, total))

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
  session: USSDShopSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'SELECT_BUNDLE' })
    return cont(bundleMenu(session.shopName!, session.bundleCache ?? [], session.bundlePage ?? 0, session.bundleTotal ?? 0))
  }

  const raw = input.trim().replace(/\s+/g, '')
  const local = raw.startsWith('+233') ? '0' + raw.slice(4)
    : raw.startsWith('233') ? '0' + raw.slice(3)
    : raw

  if (!/^0[0-9]{9}$/.test(local)) {
    return cont('Invalid number.\nEnter a valid Ghana\nphone number:\n\n0. Back')
  }

  await setSession(sessionId, { ...session, step: 'CONFIRM', recipientPhone: local })

  return cont(confirmMenu(
    session.shopName!,
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
  session: USSDShopSession
): Promise<UzoResponse> {
  if (input.trim() === '2' || input.trim() === '0') {
    return end('Order cancelled.')
  }

  if (input.trim() !== '1') {
    return cont(confirmMenu(
      session.shopName!,
      session.network!,
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!
    ))
  }

  const { shopCodeId, shopId, parentShopId, network, paystackProvider, bundleId, bundleSize, bundlePrice, recipientPhone, dialingPhone } = session

  // Re-fetch retail price from DB to prevent stale session attacks
  let verifiedPrice: number
  let profitAmount: number

  if (parentShopId) {
    const { data: catalogRow } = await supabase
      .from("sub_agent_catalog")
      .select("wholesale_margin, sub_agent_profit_margin, packages!inner(price, active)")
      .eq("shop_id", parentShopId)
      .eq("package_id", bundleId!)
      .eq("is_active", true)
      .maybeSingle()

    if (!catalogRow || !(catalogRow as any).packages?.active) {
      return end('Bundle no longer available. Please try again.')
    }

    profitAmount = Number(catalogRow.sub_agent_profit_margin)
    verifiedPrice = Number((catalogRow as any).packages.price) + Number(catalogRow.wholesale_margin) + profitAmount
  } else {
    const { data: shopPkg } = await supabase
      .from("shop_packages")
      .select("profit_margin, packages!inner(price, active)")
      .eq("shop_id", shopId!)
      .eq("package_id", bundleId!)
      .eq("is_available", true)
      .maybeSingle()

    if (!shopPkg || !(shopPkg as any).packages?.active) {
      return end('Bundle no longer available. Please try again.')
    }

    profitAmount = Number(shopPkg.profit_margin)
    verifiedPrice = Number((shopPkg as any).packages.price) + profitAmount
  }

  if (Math.abs(verifiedPrice - bundlePrice!) > 0.01) {
    return end(`Price changed to GHS ${verifiedPrice.toFixed(2)}. Please restart.`)
  }

  if (!paystackProvider) {
    return end('Payment not available for this network. Contact the shop.')
  }

  // Create the order record
  const { data: order, error: orderError } = await supabase
    .from("ussd_shop_orders")
    .insert([{
      shop_code_id: shopCodeId,
      shop_id: shopId,
      dialing_phone: dialingPhone,
      recipient_phone: recipientPhone,
      network,
      paystack_provider: paystackProvider,
      package_id: bundleId,
      package_size: bundleSize,
      amount: verifiedPrice,
      shop_price: verifiedPrice,
      profit_amount: profitAmount,
      order_status: 'pending',
      payment_status: 'pending',
    }])
    .select("id")
    .single()

  if (orderError || !order) {
    console.error("[USSD-SHOP-CONFIRM] Failed to create order:", orderError)
    return end('Error creating order. Please try again.')
  }

  const orderId = order.id
  const localDialing = formatLocal(dialingPhone!)
  const email = await resolveEmail(dialingPhone!)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount: verifiedPrice,
        phone: dialingPhone!,
        provider: paystackProvider as 'mtn' | 'vod' | 'tgo',
        reference: orderId,
        metadata: {
          source: 'ussd_shop',
          ussd_shop_order_id: orderId,
          recipient_phone: recipientPhone,
          network,
          package_size: bundleSize,
          shop_id: shopId,
        },
      })
      try {
        await supabase.from("payment_attempts").insert({
          reference: orderId,
          amount: verifiedPrice,
          email,
          status: 'pending',
          payment_type: 'ussd_shop',
          order_id: orderId,
        })
      } catch (paErr) {
        console.warn("[USSD-SHOP-CONFIRM] payment_attempts insert failed (non-fatal):", paErr)
      }
      await supabase
        .from("ussd_shop_orders")
        .update({ paystack_reference: orderId, updated_at: new Date().toISOString() })
        .eq("id", orderId)
      console.log("[USSD-SHOP-CONFIRM] ✓ Charge initiated:", orderId, "status:", status)
      if (status === 'send_otp') {
        await supabase
          .from("ussd_shop_orders")
          .update({ payment_status: 'otp_required', updated_at: new Date().toISOString() })
          .eq("id", orderId)
        console.log("[USSD-SHOP-CONFIRM] OTP required — user must redial:", orderId)
      }
    } catch (err) {
      console.error("[USSD-SHOP-CONFIRM] Charge failed:", err)
      await supabase
        .from("ussd_shop_orders")
        .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  return end(paymentSentMenu(localDialing))
}

// ── SUBMIT_OTP ────────────────────────────────────────────────────────────────
export async function handleSubmitOtp(
  input: string,
  _sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await supabase
      .from("ussd_shop_orders")
      .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq("id", session.pendingOrderId)
    return end('Order cancelled.')
  }

  try {
    const { status } = await submitOtp(session.pendingOrderId!, input.trim())
    console.log("[USSD-SHOP-OTP] submitOtp status:", status, "order:", session.pendingOrderId)

    if (status === 'send_otp') {
      return cont('Invalid OTP.\nTry again:\n\n0. Cancel')
    }

    if (status === 'failed') {
      await supabase
        .from("ussd_shop_orders")
        .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", session.pendingOrderId)
      return end('OTP verification failed.\nPlease try again later.')
    }

    // OTP accepted — 3s delay then tell user to approve the MoMo push
    await new Promise(r => setTimeout(r, 3000))
    await supabase
      .from("ussd_shop_orders")
      .update({ payment_status: 'pending', updated_at: new Date().toISOString() })
      .eq("id", session.pendingOrderId)
    return end('OTP verified!\nCheck your phone for\na MoMo authorization\nprompt and approve\nto complete payment.')
  } catch (err) {
    console.error("[USSD-SHOP-OTP] submitOtp error:", err)
    return cont('Error verifying OTP.\nTry again:\n\n0. Cancel')
  }
}
