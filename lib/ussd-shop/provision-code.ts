import { secureNumericCode } from "@/lib/secure-random"

// Self-service code provisioning -- mirrors the admin route's auto-generate
// logic (app/api/admin/ussd-shops/route.ts) so a shop owner can go from "no
// code yet" to "activated" in one click, instead of needing an admin to
// create the row first.
export async function provisionShopCode(
  db: any,
  shopId: string
): Promise<{ id: string; activation_fee_paid: boolean }> {
  // The user_shops insert trigger (auto_assign_ussd_shop_code) already gives every new shop a code. Return the
  // oldest existing one rather than creating a second; only insert when the shop has none.
  const { data: existingRows, error: existingError } = await db
    .from("ussd_shop_codes")
    .select("id, activation_fee_paid")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: true })
    .limit(1)
  if (existingError) throw existingError
  if (Array.isArray(existingRows) && existingRows.length > 0) return existingRows[0]

  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = attempt < 10 ? secureNumericCode(4) : secureNumericCode(6)
    const { data: existing } = await db
      .from("ussd_shop_codes").select("id").eq("code", candidate).maybeSingle()
    if (existing) continue
    const { data: created, error } = await db
      .from("ussd_shop_codes")
      .insert([{ shop_id: shopId, code: candidate, token_balance: 0 }])
      .select("id, activation_fee_paid")
      .single()
    if (error) {
      if (error.code === "23505") continue // race on the code uniqueness — retry
      throw error
    }
    return created
  }
  throw new Error("Could not generate a unique USSD code")
}
