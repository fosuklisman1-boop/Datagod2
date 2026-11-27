import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { suspensionStatus } from "@/lib/auth/suspension"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { isTurnstileEnabled, verifyTurnstileToken, getRequestIp } from "@/lib/turnstile"
import { loadAIConfig } from "@/lib/ai-console/load-config"
import { audienceForContext, resolveAssistantSettings } from "@/lib/ai-console/settings"
import { POLICY_END_REASONS } from "@/lib/ai-voice/end-reasons"
import { resolveVoiceSettings, voiceAudienceForContext, voiceAvailable } from "@/lib/ai-voice/settings"
import { checkCallCaps, endUserIdFor } from "@/lib/ai-voice/gate"
import { buildPersonaPrompt } from "@/lib/ai-voice/prompt"
import { mintNuanceToken, type FallbackReason } from "@/lib/ai-voice/nuance"
import { candidateKeys, nuanceKeys } from "@/lib/ai-voice/keys"
import { etaSeconds, freeSlotCount, ownsTicket, waitingPosition } from "@/lib/ai-voice/queue"
import { expireStaleTickets, readLiveTickets, setTicketStatus } from "@/lib/ai-voice/queue-db"
import { readOpenByKey } from "@/lib/ai-voice/slots"
import { deviceHashFor, newDeviceId, readDeviceId, setDeviceCookie, voiceSalt } from "@/lib/ai-voice/device-cookie"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const MAX_ACCOUNT_ATTEMPTS = 3
const ACCOUNT_BUDGET_MS = 15_000

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

type Context = "home" | "storefront" | "dashboard" | "admin"
const CONTEXTS: readonly string[] = ["home", "storefront", "dashboard", "admin"]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  let body: { context?: unknown; mode?: unknown; shopSlug?: unknown; turnstileToken?: unknown; ticketId?: unknown }
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
  // The waiting-line ticket a caller was admitted on. Anything that is not a uuid is simply no ticket.
  const ticketId = typeof body.ticketId === "string" && UUID_RE.test(body.ticketId) ? body.ticketId : undefined
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
  // A waiting-line ticket this caller was admitted on stays "admitted" (holding its slot) until the call is about to
  // mint; any refusal after admission releases it so the slot is not held for the full 30 s.
  let admittedTicket: string | null = null
  let ticketConsumed = false
  const fallback = async (reason: FallbackReason) => {
    if (admittedTicket && !ticketConsumed) await setTicketStatus(supabaseAdmin, admittedTicket, "used")
    return respond({ fallback: "text", reason })
  }

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
  // The text assistant's own audience switch also turns the call off (same switch the chat route enforces).
  const assistant = resolveAssistantSettings(cfg)
  if (!assistant.audiences[audienceForContext(ctx)]) return fallback("disabled")

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
      // Admin voice only exists with the admin catalog on: its confirm cards replace every acting admin tool.
      if (!assistant.adminCatalog) return fallback("disabled")
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

  // 6b. Same identity, earlier call stopped for content/age today -> refused (the page-session block alone resets on reload).
  // 6c. Same identity, a call still open inside its own max length + 60 s -> busy (no parallel calls, no stacked mints).
  // Both run BEFORE the insert, so a refusal leaves no row behind to block the next attempt.
  const midnightUtc = new Date()
  midnightUtc.setUTCHours(0, 0, 0, 0)
  const byIdentity = <T extends { eq: (c: string, v: string) => T }>(q: T): T =>
    userId ? q.eq("user_id", userId) : q.eq("device_hash", deviceHash!)
  const policyQ = supabaseAdmin.from("ai_voice_calls").select("id", { count: "exact", head: true })
    .gte("created_at", midnightUtc.toISOString()).in("end_reason", [...POLICY_END_REASONS])
  const openCutoff = new Date(Date.now() - (voice.maxCallSeconds + 60) * 1000).toISOString()
  const openQ = supabaseAdmin.from("ai_voice_calls").select("id", { count: "exact", head: true })
    .is("ended_at", null).gt("created_at", openCutoff)
  const [pol, open] = await Promise.all([byIdentity(policyQ), byIdentity(openQ)])
  if (pol.error || open.error) return fallback("unavailable") // spends paid credits: an unreadable check fails closed
  if ((pol.count ?? 0) > 0) return fallback("policy")
  if ((open.count ?? 0) > 0) return fallback("busy")

  // 6d. Which Nuance account(s) may take this call. Every account full -> busy, before any row exists.
  // The waiting line also needs the open count with multiple accounts off (account 1 against callsPerKey).
  const keys = nuanceKeys()
  let openByKey: Record<number, number> = {}
  if (voice.multiAccount || voice.queueEnabled) {
    const read = await readOpenByKey(supabaseAdmin, openCutoff)
    if (!read) return fallback("unavailable")
    openByKey = read
  }

  // 6e. Waiting line. Runs after every gate above and BEFORE any call row exists: a queued caller costs no credits.
  if (voice.queueEnabled) {
    // A line that cannot move (no usable Nuance key) is never offered.
    if ((voice.multiAccount ? keys : keys.filter((k) => k.index === 1)).length === 0) return fallback("unavailable")
    if (!(await expireStaleTickets(supabaseAdmin, voice.queueMaxWaitMinutes * 60_000))) return fallback("unavailable")
    let live = await readLiveTickets(supabaseAdmin)
    if (!live) return fallback("unavailable")
    const who = { userId, deviceHash }
    // This caller's own admitted ticket (with or without the ticketId in the body): their turn.
    const admitted = live.find((t) => t.status === "admitted" && ownsTicket(t, who) && (!ticketId || t.id === ticketId))
    if (admitted) {
      // The ticket keeps holding its slot until just before the mint (consumed there with a compare-and-set).
      admittedTicket = admitted.id
    } else {
      const ownWaiting = live.find((t) => t.status === "waiting" && ownsTicket(t, who))
      const someoneElseLive = live.some((t) => !ownsTicket(t, who))
      const free = freeSlotCount(keys, voice.callsPerKey, openByKey, voice.multiAccount)
      if (ownWaiting || someoneElseLive || free === 0) {
        let id = ownWaiting?.id
        let position = ownWaiting ? waitingPosition(live, ownWaiting.id) : 0
        if (!id) {
          const waitingNow = live.filter((t) => t.status === "waiting").length
          if (waitingNow >= voice.queueMax) return fallback("queue_full")
          const { data: made, error: madeErr } = await supabaseAdmin.from("ai_voice_queue")
            .insert({ context: ctx, mode, ...(userId ? { user_id: userId } : { device_hash: deviceHash }) }).select("id").single()
          id = (made as { id?: string } | null)?.id
          position = waitingNow + 1
          if ((madeErr as { code?: string } | null)?.code === "23505") {
            // A parallel request from this identity created the ticket first (one live ticket per identity): reuse it.
            live = await readLiveTickets(supabaseAdmin)
            const mine = live?.find((t) => t.status === "waiting" && ownsTicket(t, who))
            if (!live || !mine) return fallback("unavailable")
            id = mine.id
            position = waitingPosition(live, mine.id)
          } else if (madeErr || !id) {
            console.error("[voice] queue ticket insert failed")
            return fallback("unavailable")
          }
        }
        const totalSlots = (voice.multiAccount ? keys.length : 1) * voice.callsPerKey
        const eta = etaSeconds(position, totalSlots, voice.maxCallSeconds)
        if (eta > voice.queueMaxWaitMinutes * 60) {
          await setTicketStatus(supabaseAdmin, id, "left")
          return fallback("busy")
        }
        return respond({ queued: true, ticketId: id, position, etaSeconds: eta })
      }
    }
  }

  const accounts = candidateKeys(keys, { multiAccount: voice.multiAccount, callsPerKey: voice.callsPerKey, openByKey })
  if (accounts.length === 0) return fallback(voice.multiAccount && keys.length > 0 ? "busy" : "unavailable")

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

  // 9. Mint: try the accounts in order; out of credits or at its start limit -> next account. Any other refusal stops.
  const mintInput = {
    systemPrompt: buildPersonaPrompt({ assistantName: assistant.name, context: ctx, tone: assistant.tone }),
    personaId: voice.personaId,
    expressiveness: voice.expressiveness,
    endUserId: endUserIdFor(userId ?? null, deviceId, voiceSalt()),
    camera: mode === "video",
  }
  // The account is claimed on the row BEFORE the mint, so a parallel request already sees the slot taken; a recount
  // after the claim (insert-then-count, like the caps) moves on if a parallel call won the slot. At most 3 accounts per
  // call and ~15 s, so a slow Nuance cannot hold the request past its time limit.
  let last: { reason: FallbackReason; key: number } | null = null
  const started = Date.now()
  let attempts = 0
  for (const account of accounts) {
    if (attempts >= MAX_ACCOUNT_ATTEMPTS || Date.now() - started > ACCOUNT_BUDGET_MS) break
    const { error: claimErr } = await supabaseAdmin.from("ai_voice_calls").update({ nuance_key: account.index }).eq("id", callId)
    if (claimErr) {
      await endRow("claim_failed")
      return fallback("unavailable")
    }
    if (voice.multiAccount) {
      const { count, error: recountErr } = await supabaseAdmin.from("ai_voice_calls").select("id", { count: "exact", head: true })
        .eq("nuance_key", account.index).is("ended_at", null).gt("created_at", openCutoff)
      if (recountErr) { await endRow("count_failed"); return fallback("unavailable") }
      if ((count ?? 0) > voice.callsPerKey) { last = { reason: "busy", key: account.index }; continue }
    }
    if (admittedTicket && !ticketConsumed) {
      // Spend the waiting-line ticket exactly once: of two parallel requests on one ticket, only one gets here.
      if (!(await setTicketStatus(supabaseAdmin, admittedTicket, "used", "admitted"))) {
        ticketConsumed = true
        await endRow("ticket_lost")
        return fallback("busy")
      }
      ticketConsumed = true
    }
    attempts++
    const minted = await mintNuanceToken({ ...mintInput, apiKey: account.key })
    if (minted.ok) return respond({ token: minted.token, callId, maxSeconds: voice.maxCallSeconds })
    last = { reason: minted.reason, key: account.index }
    if (!voice.multiAccount || (minted.reason !== "credits" && minted.reason !== "busy")) break
  }
  if (!last) last = { reason: "busy", key: accounts[0].index }
  await supabaseAdmin.from("ai_voice_calls")
    .update({ ended_at: new Date().toISOString(), end_reason: `mint_${last!.reason}`, nuance_key: last!.key }).eq("id", callId)
    .then((r: { error?: unknown }) => { if (r?.error) console.error("[voice] call row update failed") })
  return fallback(last!.reason)
}
