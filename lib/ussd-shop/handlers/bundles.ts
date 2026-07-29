import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession } from "../types"
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentSentMenu, otpMenu, sortNetworks } from "../menus"
import { setSession } from "../session"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { fetchShopBundles, verifyBundlePrice } from "@/lib/shop-commerce/pricing"
import { createShopBundleOrder } from "@/lib/shop-commerce/orders"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAGE_SIZE = 5

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

  // Whitelist gate: check once before fetching bundles
  const localDialingPhone = formatLocal(session.dialingPhone ?? '')
  const msisdn = session.dialingPhone ?? ''
  const [{ data: whitelistRow }, { data: hasPurchasedData }] = await Promise.all([
    supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
    supabase.rpc("has_completed_purchase", { local_phone: localDialingPhone, msisdn }),
  ])
  const hasPurchasedOrWhitelisted = hasPurchasedData === true
  if (whitelistRow?.value?.enabled === true && !hasPurchasedOrWhitelisted) {
    return cont('Data bundles not available.\nSign up on our app\nto unlock this service.\n\n' + networkMenu(session.shopName!, networks))
  }

  const allBundles = await fetchShopBundles(session.shopId!, selectedNetwork, session.parentShopId)

  if (allBundles.length === 0) {
    return cont(`No ${selectedNetwork} bundles available.\n\n${networkMenu(session.shopName!, networks)}`)
  }

  if (!paystackProvider) {
    return cont(`Payment not available for your number.\nContact the shop.\n\n${networkMenu(session.shopName!, networks)}`)
  }

  const firstMenu = bundleMenu(session.shopName!, allBundles.slice(0, PAGE_SIZE), 0, allBundles.length)
  await setSession(sessionId, {
    ...session,
    step: 'SELECT_BUNDLE',
    network: selectedNetwork,
    paystackProvider,
    bundlePage: 0,
    bundleCache: allBundles,
    bundleTotal: allBundles.length,
    bundlePageShown: firstMenu.shown,
  })

  return cont(firstMenu.text)
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

  const shown = session.bundlePageShown ?? pageSlice.length
  const moreIndex = offset + shown + 1
  const chosen = parseInt(input.trim(), 10)

  if (chosen === moreIndex && offset + shown < total) {
    const nextPage = page + 1
    const nextSlice = allBundles.slice(nextPage * PAGE_SIZE, (nextPage + 1) * PAGE_SIZE)
    const nextMenu = bundleMenu(session.shopName!, nextSlice, nextPage, total)
    await setSession(sessionId, { ...session, bundlePage: nextPage, bundlePageShown: nextMenu.shown })
    return cont(nextMenu.text)
  }

  const bundleIndex = chosen - offset - 1
  if (bundleIndex < 0 || bundleIndex >= shown) {
    const menu = bundleMenu(session.shopName!, pageSlice, page, total)
    await setSession(sessionId, { ...session, bundlePageShown: menu.shown })
    return cont(menu.text)
  }
  const selected = pageSlice[bundleIndex]
  if (!selected) {
    const menu = bundleMenu(session.shopName!, pageSlice, page, total)
    await setSession(sessionId, { ...session, bundlePageShown: menu.shown })
    return cont(menu.text)
  }

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
    const pg = session.bundlePage ?? 0
    const all = session.bundleCache ?? []
    const backMenu = bundleMenu(session.shopName!, all.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE), pg, session.bundleTotal ?? all.length)
    await setSession(sessionId, { ...session, step: 'SELECT_BUNDLE', bundlePageShown: backMenu.shown })
    return cont(backMenu.text)
  }

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
  const verified = await verifyBundlePrice(shopId!, bundleId!, parentShopId)
  if (!verified) {
    return end('Bundle no longer available. Please try again.')
  }
  const { verifiedPrice, profitAmount, parentProfitAmount } = verified

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
  const orderResult = await createShopBundleOrder({
    shopCodeId: shopCodeId!,
    shopId: shopId!,
    parentShopId: parentShopId ?? null,
    dialingPhone: dialingPhone!,
    recipientPhone: recipientPhone!,
    network: network!,
    paystackProvider: paystackProvider!,
    bundleId: bundleId!,
    bundleSize: bundleSize!,
    verifiedPrice,
    profitAmount,
    parentProfitAmount,
    chargeAmount,
    shopName: session.shopName ?? null,
    customerEmail: customerEmail ?? null,
    shopOwnerEmail,
    channel: "ussd_shop",
  })

  if ("error" in orderResult) {
    console.error("[USSD-SHOP-CONFIRM] Failed to create order:", orderResult.error)
    return end('Error creating order. Please try again.')
  }

  const orderId = orderResult.orderId
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

  const otp = input.trim()
  const orderId = session.pendingOrderId!

  // Mark pending before closing session to prevent re-OTP prompt on quick redial
  await supabase
    .from("ussd_shop_orders")
    .update({ payment_status: 'pending', updated_at: new Date().toISOString() })
    .eq("id", orderId)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await submitOtp(orderId, otp)
      console.log("[USSD-SHOP-OTP] submitOtp status:", status, "order:", orderId)
      if (status === 'failed') {
        await supabase
          .from("ussd_shop_orders")
          .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
          .eq("id", orderId)
      }
    } catch (err) {
      console.error("[USSD-SHOP-OTP] submitOtp error:", err)
      await supabase
        .from("ussd_shop_orders")
        .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  return end('Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment.')
}
