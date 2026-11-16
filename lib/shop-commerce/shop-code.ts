import { createClient } from "@supabase/supabase-js"

// Channel-agnostic shop-code resolver. Extracted from the lookup portion of
// lib/ussd-shop/handlers/shop.ts's handleEnterShopCode, so both the USSD shop
// and the WhatsApp shop bot can share the exact same "what does this code
// mean" logic. Deliberately does NOT deduct tokens, build network lists, or
// write session state — those stay channel-specific and live in the callers.
// It also does NOT gate on status/token balance/activation — it just resolves
// and reports the facts; the caller decides whether the code is "usable".

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export interface ResolvedShopCode {
  shopCodeId: string
  shopId: string
  shopName: string
  parentShopId: string | null
  status: string
  /** Legacy session-token balance. Unused for gating since 2026-10-14 (sessions retired). */
  tokenBalance: number
  whatsappActivated: boolean
  /** Shop owner's phone as local 0XXXXXXXXX, shown as the USSD "Helpline"; null when unknown/unusable. */
  ownerPhone?: string | null
}

export async function resolveShopCode(
  code: string,
  client: SupabaseClientLike = supabase
): Promise<ResolvedShopCode | null> {
  const { data: shopCode, error } = await client
    .from("ussd_shop_codes")
    .select("id, shop_id, status, token_balance, whatsapp_activated")
    .eq("code", code.trim())
    .maybeSingle()

  if (error) console.error("resolveShopCode: ussd_shop_codes query failed", error)
  if (!shopCode) return null

  const { data: shopRow, error: shopError } = await client
    .from("user_shops")
    .select("shop_name, parent_shop_id, ussd_display_name, is_active, is_blocked, user_id")
    .eq("id", shopCode.shop_id)
    .single()

  // Fail closed: this resolver is the only gate on Uzo USSD, Hubtel USSD and the WhatsApp shop bot, so a
  // failed or empty shop read must never fall back to the code's own (usually active) status.
  if (shopError || !shopRow) {
    console.error("resolveShopCode: user_shops read failed", { code: (shopError as any)?.code, message: (shopError as any)?.message })
    return {
      shopCodeId: shopCode.id,
      shopId: shopCode.shop_id,
      shopName: 'Shop',
      parentShopId: null,
      status: "inactive",
      tokenBalance: shopCode.token_balance,
      whatsappActivated: shopCode.whatsapp_activated === true,
      ownerPhone: null,
    }
  }

  return {
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    shopName: shopRow?.ussd_display_name || shopRow?.shop_name || 'Shop',
    parentShopId: (shopRow as any)?.parent_shop_id ?? null,
    // Effective status: a blocked or not-yet-approved shop is closed on every channel even when its
    // code is active (sessions are free since 2026-10-14, so nothing else gates these shops).
    status: (shopRow as any)?.is_blocked === true ? "suspended"
      : (shopRow as any)?.is_active === false ? "inactive"
      : shopCode.status,
    tokenBalance: shopCode.token_balance,
    whatsappActivated: shopCode.whatsapp_activated === true,
    ownerPhone: await ownerPhoneFor((shopRow as any)?.user_id, client),
  }
}

/**
 * The shop owner's number for the USSD "Helpline" line. Best effort: any miss or read failure is null
 * (the line is simply left off) and never blocks shop entry. user_shops.user_id references auth.users,
 * so PostgREST cannot embed public.users; this is a separate read.
 */
async function ownerPhoneFor(userId: string | null | undefined, client: SupabaseClientLike): Promise<string | null> {
  if (!userId) return null
  try {
    const { data, error } = await client.from("users").select("phone_number").eq("id", userId).maybeSingle()
    if (error) {
      console.error("resolveShopCode: owner phone read failed", { code: (error as any)?.code })
      return null
    }
    return toHelplineNumber((data as any)?.phone_number)
  } catch {
    return null
  }
}

/** A stored Ghana number (0XXXXXXXXX, 233/+233..., 9 bare digits, spaces allowed) as local 0XXXXXXXXX; else null. */
export function toHelplineNumber(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "")
  if (/^0\d{9}$/.test(digits)) return digits
  if (/^233\d{9}$/.test(digits)) return "0" + digits.slice(3)
  if (/^[1-9]\d{8}$/.test(digits)) return "0" + digits
  return null
}

// Looks up a shop's real, unfiltered shop_name directly by id — for callers
// that only have a shopId in hand (e.g. a USSD/WhatsApp session) and need
// the canonical name for record-keeping (see ResolvedShopCode.canonicalShopName).
export async function getCanonicalShopName(
  shopId: string,
  client: SupabaseClientLike = supabase
): Promise<string> {
  const { data } = await client
    .from("user_shops")
    .select("shop_name")
    .eq("id", shopId)
    .single()

  return (data as any)?.shop_name ?? 'Shop'
}

// Distinct, deduped list of networks a shop's Data Bundle catalog currently offers.
// Extracted from the network-listing block inside lib/ussd-shop/handlers/shop.ts's
// handleEnterShopCode (the USSD entry handler) so the WhatsApp shop bot can build the
// same list without duplicating the sub-agent/regular-shop branching. Deliberately
// returns an UNSORTED, deduped list — display ordering (sortNetworks) stays a
// presentation concern for the caller (see lib/ussd-shop/menus.ts /
// lib/whatsapp-bot/shop-menus.ts), matching how resolveShopCode above also just
// resolves facts without deciding how they're shown.
export async function fetchShopNetworks(
  shopId: string,
  parentShopId?: string | null,
  client: SupabaseClientLike = supabase
): Promise<string[]> {
  const networks: string[] = []
  const seen = new Set<string>()

  if (parentShopId) {
    // New model: sub-agent's own package list
    const { data: sapRows } = await client
      .from("sub_agent_shop_packages")
      .select("package_id")
      .eq("shop_id", shopId)
      .eq("is_active", true)

    const packageIds: string[] = sapRows?.length
      ? sapRows.map((r: any) => r.package_id)
      : await client
          .from("sub_agent_catalog")
          .select("package_id")
          .eq("shop_id", parentShopId)
          .eq("is_active", true)
          .then((r: any) => r.data?.map((row: any) => row.package_id) ?? [])

    if (packageIds.length) {
      const { data: pkgRows } = await client
        .from("packages")
        .select("network")
        .in("id", packageIds)
        .eq("is_available", true)

      for (const pkg of pkgRows ?? []) {
        if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
      }
    }
    return networks
  }

  const { data: spRows } = await client
    .from("shop_packages")
    .select("package_id")
    .eq("shop_id", shopId)
    .eq("is_available", true)

  if (spRows?.length) {
    const { data: pkgRows } = await client
      .from("packages")
      .select("network")
      .in("id", spRows.map((r: any) => r.package_id))
      .eq("is_available", true)

    for (const pkg of pkgRows ?? []) {
      if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
    }
  }
  return networks
}
