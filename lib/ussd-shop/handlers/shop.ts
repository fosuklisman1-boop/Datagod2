import { createClient } from "@supabase/supabase-js"
import { UzoResponse } from "../types"
import { cont, end, enterShopCodeMenu, invalidCodeMenu, networkMenu } from "../menus"
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
    // Sub-agent: catalog lives under the parent shop
    const { data: catalogRows } = await supabase
      .from("sub_agent_catalog")
      .select("packages!inner(network)")
      .eq("shop_id", parentShopId)
      .eq("is_active", true)
      .eq("packages.active", true)

    const seen = new Set<string>()
    for (const row of catalogRows ?? []) {
      const net = (row as any).packages?.network
      if (net && !seen.has(net)) { seen.add(net); networks.push(net) }
    }
  } else {
    // Regular shop: catalog lives in shop_packages
    const { data: networkRows } = await supabase
      .from("shop_packages")
      .select("packages!inner(network)")
      .eq("shop_id", shopCode.shop_id)
      .eq("is_available", true)
      .eq("packages.active", true)

    const seen = new Set<string>()
    for (const row of networkRows ?? []) {
      const net = (row as any).packages?.network
      if (net && !seen.has(net)) { seen.add(net); networks.push(net) }
    }
  }

  if (networks.length === 0) {
    await setSession(sessionId, { step: 'ENTER_SHOP_CODE', dialingPhone })
    return cont(invalidCodeMenu('Shop has no bundles available.'))
  }

  await setSession(sessionId, {
    step: 'SELECT_NETWORK',
    dialingPhone,
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    parentShopId: parentShopId ?? undefined,
    shopName,
    networks,
  })

  return cont(networkMenu(shopName, networks))
}
