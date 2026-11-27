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
  const rlKey = userId ?? deviceHash ?? getRequestIp(req.headers) ?? "unknown"
  const rl = await applyRateLimit(req, "ai_voice_token", 10, 60_000, rlKey)
  if (!rl.allowed) return respond({ error: "Too many requests. Please wait a moment." }, 429)

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

  // 7. Counts (today = UTC midnight) and caps
  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)
  const since = midnight.toISOString()
  let mineToday = 0
  let visitorsToday = 0
  if (audience !== "admin") {
    let mine = supabaseAdmin.from("ai_voice_calls").select("id", { count: "exact", head: true }).gte("created_at", since).eq("context", ctx)
    mine = userId ? mine.eq("user_id", userId) : mine.eq("device_hash", deviceHash!)
    const visitors = supabaseAdmin.from("ai_voice_calls").select("id", { count: "exact", head: true }).gte("created_at", since).in("context", ["home", "storefront"])
    const [m, v] = await Promise.all([mine, visitors])
    if (m.error || v.error) return fallback("unavailable")
    mineToday = m.count ?? 0
    visitorsToday = v.count ?? 0
  }
  const caps = checkCallCaps(audience, voice, { mineToday, visitorsToday })
  if (!caps.ok) return fallback(caps.reason)

  // 8. Record the call BEFORE minting; a refused mint keeps the row (it counts toward the caps).
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
    await supabaseAdmin.from("ai_voice_calls").update({ ended_at: new Date().toISOString(), end_reason: `mint_${minted.reason}` }).eq("id", callId)
    return fallback(minted.reason)
  }
  return respond({ token: minted.token, callId, maxSeconds: voice.maxCallSeconds })
}
