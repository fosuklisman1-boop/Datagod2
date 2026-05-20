import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession, ShopBundleOption } from "../types"
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentSentMenu, otpMenu, sortNetworks } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { sendSMS } from "@/lib/sms-service"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAGE_SIZE = 5


function sizeToMb(size: string): number {
  const m = size.trim().match(/(\d+(?:\.\d+)?)\s*(MB|GB|TB)/i)
  if (!m) return 0
  const v = parseFloat(m[1])
  switch (m[2].toUpperCase()) {
    case 'MB': return v
    case 'GB': return v * 1024
    case 'TB': return v * 1024 * 1024
    default: return 0
  }
}

async function fetchShopBundles(
  shopId: string,
  network: string,
  parentShopId?: string
): Promise<ShopBundleOption[]> {
  if (parentShopId) {
    const { data: catalogRows } = await supabase
      .from("sub_agent_catalog")
      .select("package_id, wholesale_margin, sub_agent_profit_margin")
      .eq("shop_id", parentShopId)
      .eq("is_active", true)

    if (!catalogRows?.length) return []

    const { data: pkgRows } = await supabase
      .from("packages")
      .select("id, size, price")
      .in("id", catalogRows.map(r => r.package_id))
      .eq("network", network)
      .eq("active", true)

    if (!pkgRows?.length) return []

    const catMap = Object.fromEntries(catalogRows.map(r => [r.package_id, r]))
    return pkgRows
      .map(pkg => ({
        id: pkg.id,
        size: pkg.size,
        price: Number(pkg.price) + Number(catMap[pkg.id].wholesale_margin) + Number(catMap[pkg.id].sub_agent_profit_margin),
      }))
      .sort((a, b) => sizeToMb(a.size) - sizeToMb(b.size))
  }

  const { data: spRows } = await supabase
    .from("shop_packages")
    .select("package_id, profit_margin")
    .eq("shop_id", shopId)
    .eq("is_available", true)

  if (!spRows?.length) return []

  const { data: pkgRows } = await supabase
    .from("packages")
    .select("id, size, price")
    .in("id", spRows.map(r => r.package_id))
    .eq("network", network)
    .eq("active", true)

  if (!pkgRows?.length) return []

  const profitMap = Object.fromEntries(spRows.map(r => [r.package_id, r.profit_margin]))
  return pkgRows
    .map(pkg => ({
      id: pkg.id,
      size: pkg.size,
      price: Number(pkg.price) + Number(profitMap[pkg.id] ?? 0),
    }))
    .sort((a, b) => sizeToMb(a.size) - sizeToMb(b.size))
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
  const networks = sortNetworks(session.networks ?? [])

  if (input.trim() === '0') {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone: session.dialingPhone })
    return cont('Enter shop code:\n\n0. Exit')
  }

  const idx = parseInt(input.trim(), 10) - 1
  const selectedNetwork = networks[idx]

  if (!selectedNetwork) {
    return cont(networkMenu(session.shopName!, networks))
  }

  const paystackProvider = paystackProviderFromPhone(session.dialingPhone ?? '')

  const allBundles = await fetchShopBundles(session.shopId!, selectedNetwork, session.parentShopId)

  if (allBundles.length === 0) {
    return cont(`No ${selectedNetwork} bundles available.\n\n${networkMenu(session.shopName!, networks)}`)
  }

  if (!paystackProvider) {
    return cont(`Payment not available for your number.\nContact the shop.\n\n${networkMenu(session.shopName!, networks)}`)
  }

  await setSession(sessionId, {
    ...session,
    step: 'SELECT_BUNDLE',
    network: selectedNetwork,
    paystackProvider,
    bundlePage: 0,
    bundleCache: allBundles,
    bundleTotal: allBundles.length,
  })

  return cont(bundleMenu(session.shopName!, allBundles.slice(0, PAGE_SIZE), 0, allBundles.length))
}

// ── SELECT_BUNDLE ─────────────────────────────────────────────────────────────
export async function handleSelectBundle(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  if (input.trim() === '0') {
    await setSession(sessionId, { ...session, step: 'SELECT_NETWORK', bundlePage: 0 })
    return cont(networkMenu(session.shopName!, session.networks ?? []))
  }

  const page = session.bundlePage ?? 0
  const allBundles = session.bundleCache ?? []
  const total = session.bundleTotal ?? allBundles.length
  const offset = page * PAGE_SIZE
  const pageSlice = allBundles.slice(offset, offset + PAGE_SIZE)

  const moreIndex = offset + pageSlice.length + 1
  const chosen = parseInt(input.trim(), 10)

  if (chosen === moreIndex && offset + pageSlice.length < total) {
    const nextPage = page + 1
    const nextSlice = allBundles.slice(nextPage * PAGE_SIZE, (nextPage + 1) * PAGE_SIZE)
    await setSession(sessionId, { ...session, bundlePage: nextPage })
    return cont(bundleMenu(session.shopName!, nextSlice, nextPage, total))
  }

  const bundleIndex = chosen - offset - 1
  const selected = allBundles[bundleIndex]
  if (!selected) return cont(bundleMenu(session.shopName!, pageSlice, page, total))

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
    const pg = session.bundlePage ?? 0
    const all = session.bundleCache ?? []
    return cont(bundleMenu(session.shopName!, all.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE), pg, session.bundleTotal ?? all.length))
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

  const { data: feeSettings } = await supabase
    .from("app_settings")
    .select("paystack_fee_percentage")
    .single()
  const feePercent = (feeSettings?.paystack_fee_percentage ?? 3.0) / 100
  const fee = Math.round(verifiedPrice * feePercent * 100) / 100
  const chargeAmount = verifiedPrice + fee

  // Resolve customer email and shop owner email before inserting
  const [customerEmail, shopOwnerRow] = await Promise.all([
    resolveEmail(dialingPhone!).catch(() => null),
    supabase
      .from("user_shops")
      .select("user_id, users!inner(email)")
      .eq("id", shopId!)
      .single()
      .then(r => r.data),
  ])
  const shopOwnerEmail: string | null = (shopOwnerRow as any)?.users?.email ?? null

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
      amount: chargeAmount,
      shop_price: verifiedPrice,
      profit_amount: profitAmount,
      shop_name: session.shopName ?? null,
      customer_email: customerEmail ?? null,
      shop_owner_email: shopOwnerEmail,
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
  const dialingDigits = (dialingPhone ?? '').replace(/\D/g, '')
  const email = customerEmail ?? await resolveEmail(dialingPhone!).catch(() => `${dialingDigits}@ussd.datagod.com`)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount: chargeAmount,
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
          amount: chargeAmount,
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
        sendSMS({ phone: dialingPhone!, message: SMSTemplates.ussdOtpRequired(), type: 'otp_required', reference: orderId }).catch(() => {})
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
