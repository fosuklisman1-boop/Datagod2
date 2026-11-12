import { getAdminClient, type SupabaseLike } from "@/lib/api-v2/store"

export type V1RetirementConfig = { sunsetAt: Date | null; exemptUserIds: string[] }
export type V1RetirementMode = "normal" | "notice" | "blocked" | "exempt"

const DOCS_URL = "https://www.datagod.store/developers"
const CACHE_MS = 60_000
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function v1RetirementState(
  cfg: V1RetirementConfig | null,
  userId: string,
  now: Date
): { mode: V1RetirementMode; sunsetAt: Date | null } {
  if (!cfg || !cfg.sunsetAt) return { mode: "normal", sunsetAt: null }
  const sunsetAt = cfg.sunsetAt
  if (cfg.exemptUserIds.includes(userId)) return { mode: "exempt", sunsetAt }
  return { mode: now.getTime() >= sunsetAt.getTime() ? "blocked" : "notice", sunsetAt }
}

/** Ghana is UTC+0 year-round; always uses UTC getters, never machine-local time. */
export function formatGhanaDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} GMT`
}

export function retirementHeaders(sunsetAt: Date): Record<string, string> {
  return {
    Deprecation: "true",
    Sunset: sunsetAt.toUTCString(),
    Link: `<${DOCS_URL}>; rel="successor-version"`,
  }
}

export function retiredBody(sunsetAt: Date): { success: false; error: "api_v1_retired"; message: string } {
  return {
    success: false,
    error: "api_v1_retired",
    message: `API v1 was retired on ${formatGhanaDate(sunsetAt)}. Please move to API v2: ${DOCS_URL}`,
  }
}

export function noticeText(sunsetAt: Date): string {
  return `API v1 will be retired on ${formatGhanaDate(sunsetAt)}. Please move to API v2: ${DOCS_URL}`
}

let cache: { at: number; value: V1RetirementConfig | null } | null = null

export function clearV1RetirementCache(): void {
  cache = null
}

/** Fail-safe: any error yields null (v1 keeps serving as normal). */
export async function getV1RetirementConfig(
  getClient: () => SupabaseLike = getAdminClient
): Promise<V1RetirementConfig | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  let value: V1RetirementConfig | null = null
  try {
    const { data, error } = await getClient()
      .from("api_v2_config")
      .select("v1_sunset_at, v1_exempt_user_ids")
      .eq("id", true)
      .maybeSingle()
    if (error || !data) {
      console.warn("[api-v1] retirement config unreadable; serving v1 as normal")
    } else {
      const parsed = data.v1_sunset_at ? new Date(data.v1_sunset_at) : null
      value = {
        sunsetAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
        exemptUserIds: Array.isArray(data.v1_exempt_user_ids) ? data.v1_exempt_user_ids : [],
      }
    }
  } catch {
    console.warn("[api-v1] retirement config read failed; serving v1 as normal")
  }
  cache = { at: Date.now(), value }
  return value
}
