import { createClient } from "@supabase/supabase-js"
import { UzoResponse } from "../types"
import { cont, end, enterShopCodeMenu, invalidCodeMenu, networkMenu, sortNetworks } from "../menus"
import { setSession } from "../session"

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
    .select("shop_name, parent_shop_id")
    .eq("id", shopCode.shop_id)
    .single()

  const shopName = shopRow?.shop_name ?? 'Shop'
  const parentShopId: string | null = (shopRow as any)?.parent_shop_id ?? null

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

  if (networks.length === 0) {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Shop has no bundles available.'))
  }

  const sortedNetworks = sortNetworks(networks)
  console.log("[USSD-SHOP] networks for shop", shopCode.shop_id, ":", sortedNetworks)

  await setSession(sessionId, {
    step: 'SELECT_NETWORK',
    dialingPhone,
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    parentShopId: parentShopId ?? undefined,
    shopName,
    networks: sortedNetworks,
  })

  return cont(networkMenu(shopName, networks))
}
