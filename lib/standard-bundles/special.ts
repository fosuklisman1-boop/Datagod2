import { getCatalog, peekCatalogBundles, type CatalogDeps, type CatalogResult, type SignedBundle } from "./catalog"
import type { BundleNetwork, CatalogBundle } from "./categories"
import type { BundlesConfig } from "./config"
import { signBundleToken, signSpecialToken } from "./token"

/** Special Bundles: MTN, dashboard only. Each plan is N × the unit bundle (the GHS 3 non-expiry one). */
export const SPECIAL_CATEGORY = "Special Bundles"

export interface SpecialUnit { bundle: CatalogBundle; mb: number }
export type SpecialEntry = SignedBundle & { special: { n: number; unitAmount: number; unitDisplay: string } }

const SIZE_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*(MB|GB)(?![a-z])/i

function sizeIn(text: unknown): number | null {
  if (typeof text !== "string") return null
  const m = SIZE_RE.exec(text)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return m[2].toUpperCase() === "GB" ? Math.round(n * 1000 * 100) / 100 : n
}

/** Size in MB from the display, else the value. 1GB = 1000MB (house convention). Null when unparseable. */
export function parseBundleMb(display: string, value: string): number | null {
  return sizeIn(display) ?? sizeIn(value)
}

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

/** Total MB shown in GB to 2 dp (3 × 406.89MB → "1.22GB"). */
export function formatSpecialGb(totalMb: number): string {
  return `${(Math.round(totalMb / 10) / 100).toFixed(2)}GB`
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
