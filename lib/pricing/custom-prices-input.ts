export type PricingMode = "role" | "custom"
export interface CustomPricesInput {
  pricing_mode: PricingMode | null
  prices: { package_id: string; price: number | null }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ROWS = 500

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v)

/** Exact 2-decimal check, same as the RPC (1.1 * 100 is 110.00000000000001, but round(110.0000..)/100 === 1.1). */
const hasAtMost2Decimals = (p: number) => Math.round(p * 100) / 100 === p

/** Same rules as the set_user_custom_prices RPC, checked up front so the admin gets per-row errors. */
export function parseCustomPricesBody(
  body: unknown
): { ok: true; value: CustomPricesInput } | { ok: false; error: string; errors: Record<string, string> } {
  const bad = (error: string, errors: Record<string, string> = {}) => ({ ok: false as const, error, errors })
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Body must be an object")
  const b = body as Record<string, unknown>

  let pricing_mode: PricingMode | null = null
  if (b.pricing_mode !== undefined) {
    if (b.pricing_mode !== "role" && b.pricing_mode !== "custom") return bad("pricing_mode must be role or custom")
    pricing_mode = b.pricing_mode
  }

  const prices: CustomPricesInput["prices"] = []
  if (b.prices !== undefined) {
    if (!Array.isArray(b.prices)) return bad("prices must be an array")
    if (b.prices.length > MAX_ROWS) return bad(`At most ${MAX_ROWS} prices per save`)
    const errors: Record<string, string> = {}
    const seen = new Set<string>()
    b.prices.forEach((row, i) => {
      const r = (row ?? {}) as Record<string, unknown>
      if (!isUuid(r.package_id)) return void (errors[i] = "Unknown package")
      const key = r.package_id.toLowerCase()
      if (seen.has(key)) return void (errors[i] = "Package listed twice")
      seen.add(key)
      if (r.price === null) return void prices.push({ package_id: r.package_id, price: null })
      const p = r.price
      if (typeof p !== "number" || !Number.isFinite(p)) return void (errors[i] = "Price must be a number")
      if (p <= 0) return void (errors[i] = "Price must be more than 0")
      if (p > 10000) return void (errors[i] = "Price must be at most 10,000")
      if (!hasAtMost2Decimals(p)) return void (errors[i] = "At most 2 decimal places")
      prices.push({ package_id: r.package_id, price: p })
    })
    if (Object.keys(errors).length) return bad("Some prices are invalid", errors)
  }

  if (pricing_mode === null && prices.length === 0) return bad("Nothing to save")
  return { ok: true, value: { pricing_mode, prices } }
}
