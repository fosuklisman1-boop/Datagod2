import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession } from "../types"
import { cont, end, enterShopCodeMenu, invalidCodeMenu, networkMenu, sortNetworks, productMenu, shopAirtimeRecipientPrompt, shopRcBoardMenu } from "../menus"
import { setSession } from "../session"
import { sendPushToUser } from "../../push-service"
import { buildRcBoardOptions } from "../../ussd/handlers/results-checker"

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

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, status, token_balance")
    .eq("code", code)
    .maybeSingle()

  if (!shopCode || shopCode.status !== 'active') {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Invalid code. Try again.'))
  }

  if (shopCode.token_balance <= 0) {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Shop has no sessions left.'))
  }

  // Atomically deduct one token
  const { data: deducted, error: deductError } = await supabase.rpc(
    'deduct_ussd_shop_token',
    { p_shop_code_id: shopCode.id }
  )

  if (deductError || !deducted) {
    console.error("[USSD-SHOP] Token deduction failed:", deductError)
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Shop unavailable. Try again.'))
  }

  // Fetch shop name and whether it is a sub-agent (has parent_shop_id)
  const { data: shopRow } = await supabase
    .from("user_shops")
    .select("shop_name, parent_shop_id, user_id")
    .eq("id", shopCode.shop_id)
    .single()

  const shopName = shopRow?.shop_name ?? 'Shop'
  const parentShopId: string | null = (shopRow as any)?.parent_shop_id ?? null
  const shopOwnerId: string | null = (shopRow as any)?.user_id ?? null

  // Alert shop owner when sessions drop to 10
  const remainingTokens = shopCode.token_balance - 1
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
      .eq("shop_id", shopCode.shop_id)
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
        .eq("active", true)

      const seen = new Set<string>()
      for (const pkg of pkgRows ?? []) {
        if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
      }
    }
  } else {
    const { data: spRows } = await supabase
      .from("shop_packages")
      .select("package_id")
      .eq("shop_id", shopCode.shop_id)
      .eq("is_available", true)

    if (spRows?.length) {
      const { data: pkgRows } = await supabase
        .from("packages")
        .select("network")
        .in("id", spRows.map(r => r.package_id))
        .eq("active", true)

      const seen = new Set<string>()
      for (const pkg of pkgRows ?? []) {
        if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
      }
    }
  }

  // Empty network list no longer blocks entry — a shop may sell only airtime or
  // results-checker vouchers (the Data option simply reports no bundles).
  const sortedNetworks = sortNetworks(networks)
  console.log("[USSD-SHOP] networks for shop", shopCode.shop_id, ":", sortedNetworks)

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
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    parentShopId: parentShopId ?? undefined,
    shopName,
    networks: sortedNetworks,
    dataBlocked,
  })

  return cont(productMenu(shopName, !dataBlocked))
}

// ── SELECT_PRODUCT ────────────────────────────────────────────────────────────
export async function handleSelectProduct(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? 'Shop'
  const dataBlocked = session.dataBlocked === true

  if (dataBlocked) {
    // Renumbered menu: 1=Airtime, 2=RC
    switch (input.trim()) {
      case '1':
        await setSession(sessionId, { ...session, step: 'SHOP_AIRTIME_ENTER_RECIPIENT' })
        return cont(shopAirtimeRecipientPrompt(shopName))
      case '2': {
        const boards = await buildRcBoardOptions()
        if (boards.length === 0) return cont('Results Checker\nunavailable.\n\n' + productMenu(shopName, false))
        await setSession(sessionId, { ...session, step: 'SHOP_RC_SELECT_BOARD', rcBoardOptions: boards })
        return cont(shopRcBoardMenu(shopName, boards))
      }
      case '0':
        return end('Goodbye.')
      default:
        return cont(productMenu(shopName, false))
    }
  }

  switch (input.trim()) {
    case '1': {
      const networks = session.networks ?? []
      if (networks.length === 0) return cont('No bundles available.\n\n' + productMenu(shopName))
      await setSession(sessionId, { ...session, step: 'SELECT_NETWORK' })
      return cont(networkMenu(shopName, networks))
    }
    case '2':
      await setSession(sessionId, { ...session, step: 'SHOP_AIRTIME_ENTER_RECIPIENT' })
      return cont(shopAirtimeRecipientPrompt(shopName))
    case '3': {
      const boards = await buildRcBoardOptions()
      if (boards.length === 0) return cont('Results Checker\nunavailable.\n\n' + productMenu(shopName))
      await setSession(sessionId, { ...session, step: 'SHOP_RC_SELECT_BOARD', rcBoardOptions: boards })
      return cont(shopRcBoardMenu(shopName, boards))
    }
    case '0':
      return end('Goodbye.')
    default:
      return cont(productMenu(shopName))
  }
}
