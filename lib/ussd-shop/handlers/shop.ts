import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession } from "../types"
import { cont, end, enterShopCodeMenu, invalidCodeMenu, networkMenu, sortNetworks, productMenu, resolveProductMenu, type ProductMenuKey, shopAirtimeRecipientPrompt, shopRcBoardMenu } from "../menus"
import { setSession } from "../session"
import { sendPushToUser } from "../../push-service"
import { buildRcBoardOptions } from "../../ussd/handlers/results-checker"
import { resolveShopCode } from "@/lib/shop-commerce/shop-code"
import { getUssdServiceVisibility } from "../../ussd-service-visibility"
import { keyForDigit } from "../../ussd/menu-items"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── ENTER_SHOP_CODE ───────────────────────────────────────────────────────────
export async function handleEnterShopCode(
  input: string,
  sessionId: string,
  dialingPhone: string
): Promise<UzoResponse> {
  if (input.trim() === '0') return end('Goodbye.')

  const code = input.trim()

  const resolved = await resolveShopCode(code)

  if (!resolved || resolved.status !== 'active') {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Invalid code. Try again.'))
  }

  if (resolved.tokenBalance <= 0) {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Shop has no sessions left.'))
  }

  // Atomically deduct one token
  const { data: deducted, error: deductError } = await supabase.rpc(
    'deduct_ussd_shop_token',
    { p_shop_code_id: resolved.shopCodeId }
  )

  if (deductError || !deducted) {
    console.error("[USSD-SHOP] Token deduction failed:", deductError)
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Shop unavailable. Try again.'))
  }

  const shopName = resolved.shopName
  const parentShopId: string | null = resolved.parentShopId

  // resolveShopCode() doesn't fetch user_shops.user_id (it only resolves
  // shop_name/parent_shop_id) — fetch it separately so the low-session push
  // alert below keeps working exactly as before.
  const { data: shopOwnerRow } = await supabase
    .from("user_shops")
    .select("user_id")
    .eq("id", resolved.shopId)
    .single()
  const shopOwnerId: string | null = (shopOwnerRow as any)?.user_id ?? null

  // Alert shop owner when sessions drop to 10
  const remainingTokens = resolved.tokenBalance - 1
  if (remainingTokens === 10 && shopOwnerId) {
    sendPushToUser(shopOwnerId, {
      title: "Low Sessions Warning",
      body: `Your USSD shop "${shopName}" has only 10 sessions remaining. Top up to avoid service interruption.`,
      data: { url: `/dashboard/ussd-shop` },
    }).catch(() => {})
  }

  // Fetch distinct available networks — source depends on shop type
  let networks: string[] = []

  if (parentShopId) {
    // New model: sub-agent's own package list
    const { data: sapRows } = await supabase
      .from("sub_agent_shop_packages")
      .select("package_id")
      .eq("shop_id", resolved.shopId)
      .eq("is_active", true)

    const packageIds = sapRows?.length
      ? sapRows.map(r => r.package_id)
      : await supabase
          .from("sub_agent_catalog")
          .select("package_id")
          .eq("shop_id", parentShopId)
          .eq("is_active", true)
          .then(r => r.data?.map(r => r.package_id) ?? [])

    if (packageIds.length) {
      const { data: pkgRows } = await supabase
        .from("packages")
        .select("network")
        .in("id", packageIds)
        .eq("is_available", true)

      const seen = new Set<string>()
      for (const pkg of pkgRows ?? []) {
        if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
      }
    }
  } else {
    const { data: spRows } = await supabase
      .from("shop_packages")
      .select("package_id")
      .eq("shop_id", resolved.shopId)
      .eq("is_available", true)

    if (spRows?.length) {
      const { data: pkgRows } = await supabase
        .from("packages")
        .select("network")
        .in("id", spRows.map(r => r.package_id))
        .eq("is_available", true)

      const seen = new Set<string>()
      for (const pkg of pkgRows ?? []) {
        if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
      }
    }
  }

  // Empty network list no longer blocks entry — a shop may sell only airtime or
  // results-checker vouchers (the Data option simply reports no bundles).
  const sortedNetworks = sortNetworks(networks)
  console.log("[USSD-SHOP] networks for shop", resolved.shopId, ":", sortedNetworks)

  // Whitelist check: resolve once at session start so the product menu never
  // shows Data Bundle to callers who can't use it.
  const localPhone = dialingPhone.startsWith('+233') ? '0' + dialingPhone.slice(4)
    : dialingPhone.startsWith('233') ? '0' + dialingPhone.slice(3)
    : dialingPhone
  const [{ data: whitelistSetting }, { data: hasPurchasedData }] = await Promise.all([
    supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
    supabase.rpc("has_completed_purchase", { local_phone: localPhone, msisdn: dialingPhone }),
  ])
  const dataBlocked = whitelistSetting?.value?.enabled === true && hasPurchasedData !== true

  await setSession(sessionId, {
    step: 'SELECT_PRODUCT',
    dialingPhone,
    shopCodeId: resolved.shopCodeId,
    shopId: resolved.shopId,
    parentShopId: parentShopId ?? undefined,
    shopName,
    networks: sortedNetworks,
    dataBlocked,
  })

  const adminVisibility = await getUssdServiceVisibility(supabase)
  const effective: Partial<Record<ProductMenuKey, boolean>> = {
    data: !dataBlocked && adminVisibility.data,
    airtime: adminVisibility.airtime,
    resultsChecker: adminVisibility.resultsChecker,
  }
  return cont(productMenu(shopName, effective))
}

// ── SELECT_PRODUCT ────────────────────────────────────────────────────────────
// Numbering is derived from resolveProductMenu() — the render side
// (productMenu, above) and the parse side (keyForDigit below) both call it
// with the same visibility input, so they can never drift out of sync. See
// lib/ussd/menu-items.ts for why hand-numbering a second switch is unsafe
// here — this menu routes real payment flows.
export async function handleSelectProduct(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? 'Shop'
  const dataBlocked = session.dataBlocked === true

  if (input.trim() === '0') return end('Goodbye.')

  // Combine the per-caller whitelist gate (existing, unrelated to this
  // feature) with the admin's global service-visibility toggle — data
  // bundle only shows if BOTH allow it. Airtime/Results Checker are gated
  // only by the admin toggle.
  const adminVisibility = await getUssdServiceVisibility(supabase)
  const effective: Partial<Record<ProductMenuKey, boolean>> = {
    data: !dataBlocked && adminVisibility.data,
    airtime: adminVisibility.airtime,
    resultsChecker: adminVisibility.resultsChecker,
  }
  const resolved = resolveProductMenu(effective)
  const matchedKey = keyForDigit(resolved, input)

  switch (matchedKey) {
    case 'data': {
      const networks = session.networks ?? []
      if (networks.length === 0) return cont('No packages available.\n\n' + productMenu(shopName, effective))
      await setSession(sessionId, { ...session, step: 'SELECT_NETWORK' })
      return cont(networkMenu(shopName, networks))
    }
    case 'airtime':
      await setSession(sessionId, { ...session, step: 'SHOP_AIRTIME_ENTER_RECIPIENT' })
      return cont(shopAirtimeRecipientPrompt(shopName))
    case 'resultsChecker': {
      const boards = await buildRcBoardOptions()
      if (boards.length === 0) return cont('Results Checker\nunavailable.\n\n' + productMenu(shopName, effective))
      await setSession(sessionId, { ...session, step: 'SHOP_RC_SELECT_BOARD', rcBoardOptions: boards })
      return cont(shopRcBoardMenu(shopName, boards))
    }
    default:
      return cont(productMenu(shopName, effective))
  }
}
