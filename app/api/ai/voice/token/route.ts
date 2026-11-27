import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { suspensionStatus } from "@/lib/auth/suspension"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { isTurnstileEnabled, verifyTurnstileToken, getRequestIp } from "@/lib/turnstile"
import { loadAIConfig } from "@/lib/ai-console/load-config"
import { resolveAssistantSettings } from "@/lib/ai-console/settings"
import { resolveVoiceSettings, voiceAudienceForContext, voiceAvailable } from "@/lib/ai-voice/settings"
import { checkCallCaps, endUserIdFor } from "@/lib/ai-voice/gate"
import { buildPersonaPrompt } from "@/lib/ai-voice/prompt"
import { mintNuanceToken, type FallbackReason } from "@/lib/ai-voice/nuance"
import { deviceHashFor, newDeviceId, readDeviceId, setDeviceCookie, voiceSalt } from "@/lib/ai-voice/device-cookie"

export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

type Context = "home" | "storefront" | "dashboard" | "admin"
const CONTEXTS: readonly string[] = ["home", "storefront", "dashboard", "admin"]

export async function POST(req: NextRequest) {
  let body: { context?: unknown; mode?: unknown; shopSlug?: unknown; turnstileToken?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  const { context, mode } = body
  if (typeof context !== "string" || !CONTEXTS.includes(context)) return NextResponse.json({ error: "Invalid context" }, { status: 400 })
  if (mode !== "voice" && mode !== "video") return NextResponse.json({ error: "Invalid mode" }, { status: 400 })
  const ctx = context as Context
  const shopSlug = typeof body.shopSlug === "string" ? body.shopSlug : undefined
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : undefined
  const isVisitorContext = ctx === "home" || ctx === "storefront"

  // Device id: always exists for home/storefront before anything is hashed. The cookie is set on every response.
  let deviceId: string | null = null
  let newDevice = false
  if (isVisitorContext) {
    deviceId = readDeviceId(req)
    if (!deviceId) { deviceId = newDeviceId(); newDevice = true }
  }
  const respond = (data: unknown, status = 200) => {
    const res = NextResponse.json(data, { status })
    if (newDevice && deviceId) setDeviceCookie(res, deviceId)
    return res
  }
  const fallback = (reason: FallbackReason) => respond({ fallback: "text", reason })

  // Identity (same bearer-JWT lookup as /api/ai/chat).
  let userId: string | undefined
  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
    if (!error && user) userId = user.id
  }
  const deviceHash = deviceId ? deviceHashFor(deviceId) : null

  // 1. Rate limit
  // Visitors are keyed by IP: a cookieless request gets a fresh device id, so the device is no bucket at all.
  const rlKey = userId ?? getRequestIp(req.headers) ?? deviceHash ?? "unknown"
  const rl = await applyRateLimit(req, "ai_voice_token", 10, 60_000, rlKey, { pgFallback: true })
  if (!rl.allowed) return respond({ error: "Too many requests. Please wait a moment." }, 429)
  // This path spends paid credits: a limiter that could not count fails closed.
  if (rl.degraded) return fallback("unavailable")

  // 2. Config + availability
  const cfg = await loadAIConfig(supabaseAdmin)
  const voice = resolveVoiceSettings(cfg)
  const audience = voiceAudienceForContext(ctx)
  if (!audience || !voiceAvailable(voice, audience)) return fallback("disabled")

  // 3. Identity / admin gate
  if ((ctx === "dashboard" || ctx === "admin") && !userId) return respond({ error: "Unauthorized" }, 401)
  if (userId) {
    // 4. Suspension (fails closed; a failed read says unavailable)
    const suspension = await suspensionStatus(supabaseAdmin, userId)
    if (suspension === "suspended") return fallback("suspended")
    if (suspension === "unknown") return fallback("unavailable")
    if (ctx === "admin") {
      const { data: profile } = await supabaseAdmin.from("users").select("role").eq("id", userId).maybeSingle()
      if ((profile as { role?: string } | null)?.role !== "admin") return respond({ error: "Admin access required" }, 403)
    }
  }

  // 5. Storefront shop (server-side lookup, same match as chat)
  let shopId: string | null = null
  if (ctx === "storefront") {
    if (!shopSlug) return fallback("shop_unavailable")
    const { data: shop } = await supabaseAdmin
      .from("user_shops")
      .select("id, is_active, is_blocked")
      .or(shopHandleOrFilter(shopSlug))
      .maybeSingle()
    const s = shop as { id?: string; is_active?: boolean; is_blocked?: boolean } | null
    if (!s?.id || s.is_active === false || s.is_blocked === true) return fallback("shop_unavailable")
    shopId = s.id
  }

  // 6. Turnstile (home/storefront only; skipped when disabled)
  if (isVisitorContext && (await isTurnstileEnabled())) {
    const t = await verifyTurnstileToken(turnstileToken, getRequestIp(req.headers))
    if (!t.valid) return fallback("bot")
  }

  // 7. Record the call FIRST, then count including it: parallel requests cannot all pass a stale count.
  // A refused mint keeps its row (it counts toward the caps); a cap_exceeded row does not.
  const row: Record<string, unknown> = {
    context: ctx, mode, persona_id: voice.personaId, max_seconds: voice.maxCallSeconds,
    ...(userId ? { user_id: userId } : { device_hash: deviceHash }),
    ...(shopId ? { shop_id: shopId } : {}),
  }
  const { data: inserted, error: insErr } = await supabaseAdmin.from("ai_voice_calls").insert(row).select("id").single()
  const callId = (inserted as { id?: string } | null)?.id
  if (insErr || !callId) {
    console.error("[voice] call row insert failed")
    return fallback("unavailable")
  }

  // 8. Counts (today = UTC midnight), including the row just inserted, then caps.
  const endRow = (reason: string) =>
    supabaseAdmin.from("ai_voice_calls").update({ ended_at: new Date().toISOString(), end_reason: reason }).eq("id", callId)
      .then((r: { error?: unknown }) => { if (r?.error) console.error("[voice] call row update failed") })
  if (audience !== "admin") {
    const midnight = new Date()
    midnight.setUTCHours(0, 0, 0, 0)
    const since = midnight.toISOString()
    const counted = () => supabaseAdmin.from("ai_voice_calls").select("id", { count: "exact", head: true })
      .gte("created_at", since).or("end_reason.is.null,end_reason.neq.cap_exceeded")
    let mine = counted().eq("context", ctx)
    mine = userId ? mine.eq("user_id", userId) : mine.eq("device_hash", deviceHash!)
    // Signed-in users are never blocked by the visitor total: it counts anonymous rows only and is skipped for them.
    const visitors = userId ? null : counted().in("context", ["home", "storefront"]).is("user_id", null)
    const [m, v] = await Promise.all([mine, visitors])
    if (m.error || v?.error) {
      await endRow("count_failed")
      return fallback("unavailable")
    }
    // Both counts include this call's own row.
    const caps = checkCallCaps(audience, voice, {
      mineToday: Math.max(0, (m.count ?? 0) - 1),
      visitorsToday: userId ? 0 : Math.max(0, (v?.count ?? 0) - 1),
    })
    if (!caps.ok) {
      await endRow("cap_exceeded")
      return fallback(caps.reason)
    }
  }

  // 9. Mint
  const assistant = resolveAssistantSettings(cfg)
  const minted = await mintNuanceToken({
    systemPrompt: buildPersonaPrompt({ assistantName: assistant.name, context: ctx, tone: assistant.tone }),
    personaId: voice.personaId,
    expressiveness: voice.expressiveness,
    endUserId: endUserIdFor(userId ?? null, deviceId, voiceSalt()),
    camera: mode === "video",
  })
  if (!minted.ok) {
    await endRow(`mint_${minted.reason}`)
    return fallback(minted.reason)
  }
  return respond({ token: minted.token, callId, maxSeconds: voice.maxCallSeconds })
}
