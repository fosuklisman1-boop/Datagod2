/** Pure helpers for Special Bundles. No server imports, so client components can use them too. */

/** Special Bundles: MTN, dashboard only. Each plan is N × the unit bundle (the GHS 3 non-expiry one). */
export const SPECIAL_CATEGORY = "Special Bundles"

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

/** Total MB shown in GB to 2 dp (3 × 406.89MB → "1.22GB"). */
export function formatSpecialGb(totalMb: number): string {
  return `${(Math.round(totalMb / 10) / 100).toFixed(2)}GB`
}
