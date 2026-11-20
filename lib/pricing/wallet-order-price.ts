import { getCustomPrices } from "@/lib/pricing/package-price"
import { roleBasePrices, priceWith } from "@/lib/roles/pricing"

/**
 * The price a wallet order is charged: the role price, or the user's custom price when an admin has put them on
 * custom pricing. Moved verbatim from app/api/orders/purchase/route.ts so the route and the AI confirm card quote
 * the same number. Throws CustomPriceReadError / RoleReadError when a read fails; callers must refuse the purchase
 * (never charge a possibly wrong price).
 */
export async function walletOrderPrice(
  db: any,
  userId: string,
  userRole: string,
  pkg: { id: string; size: any; price: number; dealer_price: number | null; is_available: boolean },
): Promise<number> {
  const custom = await getCustomPrices(db, userId)
  const base = await roleBasePrices(db, userRole, [pkg as any], { admin: "as_user" })
  return priceWith(base, pkg as any, custom)
}
