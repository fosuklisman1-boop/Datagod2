import { createClient } from "@supabase/supabase-js"
import { after } from "next/server"
import { UzoResponse, USSDSession, BundleOption } from "../types"
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, mainMenu } from "../menus"
import { getSession, setSession } from "../session"
import { resolveEmail } from "../resolve-email"
import { chargeMobileMoney } from "../../paystack"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAGE_SIZE = 5

const NETWORK_OPTIONS: Record<string, { dbName: string; paystackProvider: 'mtn' | 'vod' | 'atl' }> = {
  '1': { dbName: 'MTN', paystackProvider: 'mtn' },
  '2': { dbName: 'Telecel', paystackProvider: 'vod' },
  '3': { dbName: 'AirtelTigo', paystackProvider: 'atl' },
  '4': { dbName: 'AT-iShare', paystackProvider: 'atl' },
}

async function fetchBundles(network: string, page: number): Promise<{ bundles: BundleOption[]; total: number; priceTier: string }> {
  // Read price tier from app_settings
  const { data: settings } = await supabase
    .from("app_settings")
    .select("ussd_price_tier")
    .single()
  const priceTier: string = settings?.ussd_price_tier ?? 'regular'

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

  return { bundles, total: count ?? 0, priceTier }
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

  const { bundles, total, priceTier } = await fetchBundles(net.dbName, 0)
  if (bundles.length === 0) {
    return cont(`No ${net.dbName} bundles available.\n\n${networkMenu()}`)
  }

  await setSession(sessionId, {
    ...session,
    step: 'SELECT_BUNDLE',
    network: net.dbName,
    paystackProvider: net.paystackProvider,
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
    const { bundles: nextBundles, total: newTotal } = await fetchBundles(session.network!, nextPage)
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

  const { data: settings } = await supabase
    .from("app_settings")
    .select("ussd_price_tier")
    .single()
  const priceTier: string = settings?.ussd_price_tier ?? 'regular'
  const useDealer = priceTier === 'dealer' && pkg.dealer_price && Number(pkg.dealer_price) > 0
  const verifiedPrice = useDealer ? Number(pkg.dealer_price) : Number(pkg.price)

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
      amount: verifiedPrice,
      price_tier: priceTier,
      order_status: 'pending',
      payment_status: 'pending',
    }])
    .select("id")
    .single()

  if (orderError || !order) {
    console.error("[USSD-CONFIRM] Failed to create order:", orderError)
    return end('Error creating order. Please try again.')
  }

  // Resolve email for Paystack
  const email = await resolveEmail(dialingPhone!)
  const orderId = order.id

  // Fire charge 3 seconds after the USSD session closes
  after(async () => {
    await new Promise(resolve => setTimeout(resolve, 3000))
    try {
      await chargeMobileMoney({
        email,
        amount: verifiedPrice,
        phone: dialingPhone!,
        provider: paystackProvider as 'mtn' | 'vod' | 'atl',
        reference: orderId,
        metadata: {
          source: 'ussd',
          ussd_order_id: orderId,
          recipient_phone: recipientPhone,
          network,
          package_size: bundleSize,
        },
      })
      await supabase
        .from("ussd_orders")
        .update({ paystack_reference: orderId, updated_at: new Date().toISOString() })
        .eq("id", orderId)
      console.log("[USSD-CONFIRM] ✓ Charge initiated for order:", orderId)
    } catch (err) {
      console.error("[USSD-CONFIRM] Delayed charge failed:", err)
      await supabase
        .from("ussd_orders")
        .update({ order_status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  const localDialing = dialingPhone!.startsWith('+233') ? '0' + dialingPhone!.slice(4) : dialingPhone

  return end(
    `GHS ${verifiedPrice.toFixed(2)} prompt sent to ${localDialing}.\n` +
    `Approve it to get ${bundleSize} ${network} on ${recipientPhone}.`
  )
}
