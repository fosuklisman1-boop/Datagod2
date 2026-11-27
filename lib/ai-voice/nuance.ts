// Nuance Live client: mint session tokens, map refusals, read usage.
// Never log the API key, token, prompt text or user data.

export type FallbackReason =
  | "disabled" | "daily_cap" | "visitor_cap" | "bot" | "suspended" | "shop_unavailable"
  | "credits" | "busy" | "policy" | "review_pending" | "unavailable"

const baseUrl = () => process.env.NUANCE_API_URL ?? "https://api.nuancelabs.ai"

export function mapNuanceError(status: number, code?: string, errorCode?: string): FallbackReason {
  const c = code ?? errorCode
  switch (c) {
    case "credits_spent": return "credits"
    case "concurrency_limit":
    case "start_limit":
    case "capacity_unavailable":
    case "busy": return "busy"
    case "policy_curfew":
    case "organization_paused": return "policy"
    case "app_review_held": return "review_pending"
  }
  return "unavailable"
}

export async function mintNuanceToken(
  input: { systemPrompt: string; personaId: string; expressiveness: number; endUserId: string; camera: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; token: string; warnings: string[] } | { ok: false; reason: FallbackReason; status: number; code?: string }> {
  try {
    const res = await fetchImpl(`${baseUrl()}/session-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NUANCE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        interface: "nuance_live",
        personality: { system_prompt: input.systemPrompt, persona_id: input.personaId },
        expressiveness: input.expressiveness,
        end_user_id: input.endUserId,
        interface_setup: {
          delegation: { type: "client" },
          runtime_tools: { end_call: true, call_time: true },
          video: { input: { camera: input.camera } },
        },
      }),
    })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok) {
      const token = body && typeof body.token === "string" ? body.token : null
      if (!token) {
        console.error(`[voice] mint refused ${res.status} no_token`)
        return { ok: false, reason: "unavailable", status: res.status }
      }
      const warnings = Array.isArray(body?.warnings) ? (body!.warnings as unknown[]).filter((w): w is string => typeof w === "string") : []
      return { ok: true, token, warnings }
    }
    const topCode = typeof body?.code === "string" ? body.code : undefined
    const errObj = body?.error as { code?: unknown } | undefined
    const errCode = typeof errObj?.code === "string" ? errObj.code : undefined
    const code = topCode ?? errCode
    const safe = code && /^[a-z0-9_]{1,64}$/i.test(code) ? code : "unknown"
    console.error(`[voice] mint refused ${res.status} ${safe}`)
    return { ok: false, reason: mapNuanceError(res.status, topCode, errCode), status: res.status, code }
  } catch {
    console.error("[voice] mint failed network")
    return { ok: false, reason: "unavailable", status: 0 }
  }
}

type Usage = { creditsLeft: number | null; renewsAt: string | null }
let usageCache: { at: number; value: Usage | null } | null = null
const USAGE_TTL_MS = 60_000

export function __resetNuanceUsageCache() { usageCache = null }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export async function getNuanceUsage(fetchImpl: typeof fetch = fetch): Promise<Usage | null> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value
  let value: Usage | null = null
  try {
    // TODO(verify): path + field names unconfirmed — check against live API before relying on it
    const res = await fetchImpl(`${baseUrl()}/usage`, {
      headers: { Authorization: `Bearer ${process.env.NUANCE_API_KEY}` },
    })
    if (res.status === 200) {
      const b = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const credits = (b.credits ?? {}) as Record<string, unknown>
      const creditsLeft = num(b.credits_left) ?? num(b.credits_remaining) ?? num(credits.left) ?? num(credits.remaining)
      const rawRenews = b.renews_at ?? credits.renews_at
      let renewsAt: string | null = null
      if (typeof rawRenews === "string" && rawRenews) {
        // Docs say UTC but the value may lack an offset: assume Z.
        renewsAt = /(Z|[+-]\d{2}:?\d{2})$/.test(rawRenews) ? rawRenews : `${rawRenews}Z`
      }
      value = { creditsLeft, renewsAt }
    }
  } catch {
    value = null
  }
  usageCache = { at: Date.now(), value }
  return value
}
