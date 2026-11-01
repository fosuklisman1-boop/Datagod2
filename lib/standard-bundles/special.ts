import { getCatalog, peekCatalogBundles, type CatalogDeps, type CatalogResult, type SignedBundle } from "./catalog"
import type { BundleNetwork, CatalogBundle } from "./categories"
import type { BundlesConfig } from "./config"
import { signBundleToken, signSpecialToken } from "./token"
import { formatSpecialGb, parseBundleMb, SPECIAL_CATEGORY } from "./special-format"

export { formatSpecialGb, parseBundleMb, SPECIAL_CATEGORY }

export interface SpecialUnit { bundle: CatalogBundle; mb: number }
export type SpecialEntry = SignedBundle & { special: { n: number; unitAmount: number; unitDisplay: string } }

const cents = (n: number) => Math.round(n * 100)

/**
 * The unit: the catalog item whose Value equals the admin-set `unitValue` exactly AND whose amount equals
 * `unitAmount` (to the cent), with a parseable size. (MTN Values repeat across amounts, e.g. Flexi.)
 * Duplicates of the same value and amount: largest size wins. None: null.
 */
export function findSpecialUnit(bundles: CatalogBundle[], unitAmount: number, unitValue: string): SpecialUnit | null {
  if (!unitValue) return null
  let best: SpecialUnit | null = null
  for (const bundle of bundles) {
    if (bundle.value !== unitValue || cents(bundle.amount) !== cents(unitAmount)) continue
    const mb = parseBundleMb(bundle.display, bundle.value)
    if (mb === null) continue
    if (!best || mb > best.mb) best = { bundle, mb }
  }
  return best
}

export function buildSpecialEntries(unit: SpecialUnit, multiples: number[], secret: string, now: number): SpecialEntry[] {
  const u = unit.bundle
  const unitToken = signBundleToken(
    { network: "MTN", value: u.value, amount: u.amount, display: u.display, category: u.category, issuedAt: now },
    secret,
  )
  return multiples.map((n) => ({
    value: `special:${n}`,
    display: formatSpecialGb(n * unit.mb),
    amount: cents(n * u.amount) / 100,
    category: SPECIAL_CATEGORY,
    token: signSpecialToken({ unitToken, n, issuedAt: now }, secret),
    special: { n, unitAmount: u.amount, unitDisplay: u.display },
  }))
}

/**
 * The dashboard catalog: getCatalog plus, for MTN with the switch on and a unit found, a Special category
 * listed first. Every other consumer calls getCatalog directly and is unaffected.
 */
export async function getDashboardCatalog(d: CatalogDeps, network: BundleNetwork): Promise<CatalogResult> {
  let snapshot: Promise<BundlesConfig> | null = null
  const once: CatalogDeps = { ...d, getBundlesConfig: () => (snapshot ??= d.getBundlesConfig()) }
  const res = await getCatalog(once, network)
  if (!res.ok || network !== "MTN") return res

  let cfg: BundlesConfig
  try { cfg = await once.getBundlesConfig() } catch { return res }
  if (!cfg.special?.enabled) return res

  const unit = findSpecialUnit(peekCatalogBundles("MTN") ?? [], cfg.special.unitAmount, cfg.special.unitValue)
  if (!unit) return res
  const entries = buildSpecialEntries(unit, cfg.special.multiples, d.secret, d.now())
  return { ok: true, categories: [{ name: SPECIAL_CATEGORY, bundles: entries }, ...res.categories] }
}
