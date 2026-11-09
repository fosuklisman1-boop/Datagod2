import { subAgentCosts } from "@/lib/shop-commerce/pricing"

export type WholesalePackage = { network: string; size: string; wholesale_price: number }

/**
 * What a new sub-agent would pay for each package the parent offers, from the live cost rule
 * (subAgentCosts), never a stored parent_price. Throws CustomPriceReadError when it cannot be read.
 */
export async function getWholesalePackages(db: any, parentShopId: string): Promise<WholesalePackage[]> {
  const { costs } = await subAgentCosts(parentShopId, null, db)
  return [...costs.values()]
    .filter((o): o is NonNullable<typeof o> => o !== null)
    .map(o => ({ network: o.pkg.network, size: String(o.pkg.size), wholesale_price: o.cost }))
}
