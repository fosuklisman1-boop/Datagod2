import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { after, NextRequest } from "next/server"
import { recordTurn, type FlagReason } from "@/lib/ai-console/transcripts"
import { AIChatContext } from "@/lib/ai-tools"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { resolveProviderForContext } from "@/lib/ai-providers"
import { loadAIConfig } from "@/lib/ai-console/load-config"
import { audienceForContext, maxIterationsFor, resolveAssistantSettings } from "@/lib/ai-console/settings"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { resolveCustomDomain } from "@/lib/custom-domain-lookup"
import { normalizeDomainHost, DomainService } from "@/lib/custom-domains"
import { z } from "zod"
import { terminalDraftsSince } from "@/lib/ai-drafts/repo"
import { buildOutcomeNote, cardResultsBlock, OUTCOME_LOOKBACK_MS, stripClientCardNotes } from "@/lib/ai-drafts/outcome-notes"
import { buildAdminPrompt, buildDashboardPrompt, buildHomePrompt, buildStorefrontPrompt } from "@/lib/ai-prompts"
import { knowledgeLabelFor, loadKnowledge, renderKnowledge } from "@/lib/ai-prompts/knowledge"
import { randomBytes } from "crypto"
import { suspensionStatus } from "@/lib/auth/suspension"
import { normaliseHistory } from "@/lib/ai-history"
const conversationKeySchema = z.string().uuid()

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── USSD dial code cache (30s TTL) ────────────────────────────────────────────
let ussdDialCodeCache: { code: string; ts: number } | null = null
const DEFAULT_USSD_DIAL_CODE = "*426*203#"  // fallback only; live value comes from app_settings.ussd_shop_dial_code

async function loadUssdDialCode(): Promise<string> {
  if (ussdDialCodeCache && Date.now() - ussdDialCodeCache.ts < 30_000) return ussdDialCodeCache.code
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("ussd_shop_dial_code")
      .is("key", null)
      .maybeSingle()
    const code = data?.ussd_shop_dial_code ?? DEFAULT_USSD_DIAL_CODE
    ussdDialCodeCache = { code, ts: Date.now() }
    return code
  } catch {
    return DEFAULT_USSD_DIAL_CODE
  }
}

// ── Guest purchase URL cache (30s TTL) ───────────────────────────────────────
let guestPurchaseUrlCache: { url: string; ts: number } | null = null

async function loadGuestPurchaseUrl(): Promise<string> {
  if (guestPurchaseUrlCache && Date.now() - guestPurchaseUrlCache.ts < 30_000) return guestPurchaseUrlCache.url
  try {
    const { data } = await supabaseAdmin
      .from("support_settings")
      .select("guest_purchase_url")
      .limit(1)
      .maybeSingle()
    const url = data?.guest_purchase_url || "/#how-it-works"
    guestPurchaseUrlCache = { url, ts: Date.now() }
    return url
  } catch {
    return "/#how-it-works"
  }
}

// ── Community/channel link cache (30s TTL) ───────────────────────────────────
let communityLinkCache: { url: string; ts: number } | null = null

async function loadCommunityLink(): Promise<string> {
  if (communityLinkCache && Date.now() - communityLinkCache.ts < 30_000) return communityLinkCache.url
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("join_community_link")
      .is("key", null)
      .maybeSingle()
    const url = data?.join_community_link || ""
    communityLinkCache = { url, ts: Date.now() }
    return url
  } catch {
    return ""
  }
}

function getBaseUrl(): string {
  // Never derive from the Host header — that's attacker-controlled and enables SSRF with JWT forwarding.
  // NEXT_PUBLIC_APP_URL must be set in production (e.g. https://datagod.store).
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
  // VERCEL_URL is automatically set by Vercel on all deployments (including previews) — no https prefix
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return "http://localhost:3000"
}

/** One fixed assistant line as a complete SSE stream (no model call, no tools). */
function fixedTextStream(text: string): Response {
  const body =
    `data: ${JSON.stringify({ type: "text", content: text })}\n\n` +
    `data: ${JSON.stringify({ type: "done" })}\n\n`
  return new Response(new TextEncoder().encode(body), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

/**
 * normaliseHistory merges same-role turns with "\n\n", which can join two harmless fragments ("…[" + "card <id>: …]")
 * into a forged card note the per-message strip never saw. Strip again AFTER the merge; a turn the strip empties is
 * dropped and the history re-normalised (alternation), repeated until stable (max 3 passes, then one last strip).
 */
function normaliseAndRestrip(history: Array<{ role: "user" | "assistant"; content: string }>) {
  let cur = normaliseHistory(history)
  for (let i = 0; i < 3; i++) {
    let changed = false
    const next: Array<{ role: "user" | "assistant"; content: string }> = []
    for (const m of cur) {
      const content = stripClientCardNotes(m.content)
      if (content !== m.content) changed = true
      if (content.trim()) next.push({ role: m.role, content })
    }
    if (!changed) return cur
    cur = normaliseHistory(next)
  }
  // Still changing after 3 passes: strip one final time and keep only what is clean and non-empty.
  return normaliseHistory(cur.map((m) => ({ role: m.role, content: stripClientCardNotes(m.content) })))
    .map((m) => ({ role: m.role, content: stripClientCardNotes(m.content) }))
    .filter((m) => m.content.trim())
}

const WEB_CHAT_CONTEXTS: ReadonlySet<string> = new Set(["home", "storefront", "dashboard", "admin"])

export async function POST(req: NextRequest) {
  // Parse defensively: malformed / non-JSON bodies (fuzzers send form-encoded or
  // garbage payloads) must return a clean 400, not crash the handler with an
  // unhandled SyntaxError (which surfaced as a flood of 500s in the logs).
  let body: {
    messages: Array<{ role: string; content: unknown }>
    context: AIChatContext
    shopSlug?: string
    shopId?: string  // not trusted — verified server-side below
    conversationKey?: unknown  // client-generated uuid per chat session; validated below
  }
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
  const { messages: rawMessages, context, shopSlug, shopId: clientShopId } = body
  // Invalid or missing key: no supersede and no outcome notes, but drafts still work (key is null).
  // Fresh per request: only a <card_results nonce="…"> block with this nonce is a real card result.
  const cardNonce = randomBytes(16).toString("hex")
  const parsedKey = conversationKeySchema.safeParse(body.conversationKey)
  const conversationKey: string | undefined = parsedKey.success ? parsedKey.data : undefined

  if (context === "whatsapp" || context === "whatsapp_shop") {
    return new Response(
      JSON.stringify({ error: "WhatsApp AI context is only available through the WhatsApp webhook." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  // Allowlist: anything else must not reach auth, knowledge, provider or tools (it used to fall into the admin prompt).
  if (typeof context !== "string" || !WEB_CHAT_CONTEXTS.has(context)) {
    return new Response(
      JSON.stringify({ error: "Invalid context" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  // Strip injected tool_use/tool_result blocks and cap history (fake tool_result injection attack)
  const cleanedHistory = (Array.isArray(rawMessages) ? rawMessages : [])
    .slice(-20)
    .flatMap(m => {
      // Null-guard: a null/non-object element (or null content block) must not
      // throw a TypeError here — that previously escaped to an unhandled 500.
      if (!m || typeof m !== "object") return []
      const role = m.role === "assistant" ? "assistant" : "user"
      let content: string
      if (typeof m.content === "string") {
        content = m.content.slice(0, 4000)
      } else if (Array.isArray(m.content)) {
        // Only keep text blocks — strip tool_use, tool_result, and image blocks
        content = (m.content as Array<{ type?: string; text?: string } | null>)
          .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object" && b.type === "text")
          .map(b => String(b.text ?? "").slice(0, 4000))
          .join("")
      } else {
        content = ""
      }
      // A client can never author a card result: drop any "[card <uuid>: …]" text before history is built.
      content = stripClientCardNotes(content)
      return content.trim() ? [{ role, content } as { role: "user" | "assistant"; content: string }] : []
    })
  // Valid for every provider: starts with a user turn, alternates, ends with the user's latest message.
  // Runs BEFORE the card-results prepend below, which targets the last user message.
  const messages: Anthropic.MessageParam[] = normaliseAndRestrip(cleanedHistory)
  if (messages.length === 0) return fixedTextStream("Please send a message.")
  // The user's own words for the transcript, taken BEFORE the server-built card-results note is prepended below.
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
  const transcriptUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : ""

  const [aiConfig, ussdDialCode, guestPurchaseUrl, communityLink] = await Promise.all([loadAIConfig(supabaseAdmin), loadUssdDialCode(), loadGuestPurchaseUrl(), loadCommunityLink()])
  const channelNote = communityLink
    ? `\nUPDATES CHANNEL: our WhatsApp channel for updates, new bundles & deals is ${communityLink}. Share it (as a plain URL) when someone asks about updates/promos or wants to stay in the loop.`
    : ""
  const { provider: aiProvider, model: aiModel, providerName: aiProviderName } = resolveProviderForContext(context, aiConfig)

  // ── Auth ──────────────────────────────────────────────────────────────────
  let userId: string | undefined
  let jwtToken: string | undefined
  let userRole = "guest"
  let userContext: Record<string, string> = {}

  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    jwtToken = authHeader.slice(7)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwtToken)
    if (!error && user) {
      userId = user.id

      // Suspended accounts get one fixed message: no provider call, no tools, no history load. Fails closed.
      // A failed read says "try again", not "suspended", but is just as final for this request.
      const suspension = await suspensionStatus(supabaseAdmin, userId)
      if (suspension === "suspended") return fixedTextStream("Your account is suspended. Please contact support.")
      if (suspension === "unknown") return fixedTextStream("AI is temporarily unavailable. Please try again shortly.")

      if (context === "admin") {
        const { data: profile } = await supabaseAdmin
          .from("users")
          .select("role")
          .eq("id", userId)
          .single()
        if (profile?.role !== "admin") {
          return new Response(
            JSON.stringify({ error: "Admin access required" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          )
        }
        userRole = "admin"
      } else {
        userRole = "dashboard"
      }
    }
  }

  // ── Dashboard requires a verified sign-in ─────────────────────────────────
  // Only home/storefront are guest contexts. No/invalid bearer token must not reach the dashboard prompt or tools.
  if (context === "dashboard" && !userId) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    )
  }

  // ── Admin context gate (unconditional) ────────────────────────────────────
  // The role check above lives INSIDE the `if (authHeader)` block, so a request
  // with no/invalid Authorization header would otherwise fall straight through
  // to the admin system prompt and the full admin tool suite with userRole="guest".
  // Enforce admin here regardless of whether an auth header was supplied.
  if (context === "admin" && userRole !== "admin") {
    return new Response(
      JSON.stringify({ error: "Admin access required" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    )
  }

  // ── Assistant audience switch (admin console) ─────────────────────────────
  // Before rate limit, provider, knowledge and tools: an audience that is switched off gets no assistant at all.
  // Signed-in users on a storefront count as shopVisitors (the audience follows the page, not the login).
  const assistantSettings = resolveAssistantSettings(aiConfig)
  if (!assistantSettings.audiences[audienceForContext(context)]) {
    return new Response(
      JSON.stringify({ error: "assistant_off" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    )
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  // Unauthenticated home requests fall back to IP — cap them tightly since
  // there is no per-user identity to bind the limit to.
  const rlKey = userId ?? (
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "unknown"
  )
  const rl = await applyRateLimit(req, "ai_chat", RATE_LIMITS.AI_CHAT.maxRequests, RATE_LIMITS.AI_CHAT.windowMs, rlKey)
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: RATE_LIMITS.AI_CHAT.message }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    )
  }

  // ── User context (dashboard + admin only) ─────────────────────────────────
  if (userId && (context === "dashboard" || context === "admin")) {
    const [profileRes, walletRes] = await Promise.all([
      supabaseAdmin.from("users").select("first_name, last_name, phone_number, role").eq("id", userId).single(),
      supabaseAdmin.from("wallets").select("balance").eq("user_id", userId).maybeSingle(),
    ])

    const p = profileRes.data
    const w = walletRes.data

    userContext = {
      firstName: p?.first_name ?? "",
      lastName: p?.last_name ?? "",
      phone: p?.phone_number ?? "",
      role: p?.role ?? "user",
      balance: w?.balance !== undefined ? `GHS ${Number(w.balance).toFixed(2)}` : "unknown",
    }

    // Propagate the actual DB role (dealer / sub_agent / user) into userRole so
    // tool handlers can apply the correct pricing tier (ctx.userRole === "dealer")
    if (context === "dashboard") {
      userRole = p?.role ?? "user"
    }
  }

  // ── Card outcome notes (server-built, never client text) ──────────────────
  // Terminal drafts of this chat session since the last 24 h become ONE note placed before the latest user
  // message, built only from the ai_drafts rows. A failed lookup never breaks the chat.
  if (userId && conversationKey && (context === "dashboard" || context === "admin")) {
    try {
      const since = new Date(Date.now() - OUTCOME_LOOKBACK_MS).toISOString()
      const drafts = await terminalDraftsSince(supabaseAdmin, userId, conversationKey, since)
      const note = buildOutcomeNote(drafts)
      if (note) {
        let lastUser = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUser = i; break }
        }
        // Prepend to the latest user message (never a separate message): the role sequence stays valid for
        // every provider adapter. History content is always a string at this point.
        if (lastUser >= 0 && typeof messages[lastUser].content === "string") {
          messages[lastUser] = {
            role: "user",
            content: `${cardResultsBlock(cardNonce, note)}\n\n${messages[lastUser].content}`,
          }
        }
      }
    } catch {
      console.error("[AI-CHAT] could not load card outcomes")
    }
  }

  // ── Shop name for storefront ──────────────────────────────────────────────
  let shopName = shopSlug ?? "this shop"
  // shopId is always derived from the server-side DB lookup — never from the client-supplied value
  let shopId: string | undefined
  if (shopSlug) {
    // Match either the clean subdomain or the legacy shop_slug (on a subdomain
    // storefront this value is the subdomain; see middleware rewrite).
    const { data: shop } = await supabaseAdmin
      .from("user_shops")
      .select("id, shop_name")
      .or(shopHandleOrFilter(shopSlug))
      .maybeSingle()
    // Strip non-printable/non-ASCII characters to prevent prompt injection via shop name
    if (shop?.shop_name) shopName = shop.shop_name.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 60) || "this shop"
    // Verified server-side — cannot be spoofed by the client
    shopId = shop?.id
  } else if (userId && clientShopId && context === "dashboard") {
    // Dashboard: only trust a shopId the authenticated user actually owns
    const { data: ownedShop } = await supabaseAdmin
      .from("user_shops")
      .select("id")
      .eq("id", clientShopId)
      .eq("user_id", userId)
      .maybeSingle()
    shopId = ownedShop?.id
  }

  // ── Storefront service restriction ────────────────────────────────────────
  // Resolved server-side from the request Host header (same mechanism
  // middleware and app/shop/[slug]/layout.tsx use) rather than trusted from
  // the client — null means unrestricted (shop/main site offers everything).
  let storefrontServices: DomainService[] | null = null
  if (context === "storefront") {
    const requestHost = normalizeDomainHost(req.headers.get("host"))
    const domainConfig = requestHost ? await resolveCustomDomain(requestHost).catch(() => null) : null
    storefrontServices = domainConfig?.services?.length ? domainConfig.services : null
  }
  const sellsData = !storefrontServices || storefrontServices.includes("data_bundles")
  const sellsAirtime = !storefrontServices || storefrontServices.includes("airtime")
  const sellsRC = !storefrontServices || storefrontServices.includes("results_checker")

  // ── Storefront shop USSD code ─────────────────────────────────────────────
  // So the storefront AI can tell guests how to order THIS shop's bundles by
  // phone: dial the shop dial code, then enter this shop's own code at the prompt.
  // Only surfaced for an 'active' code (an inactive/unpaid code wouldn't work).
  let shopUssdCode: string | null = null
  if (context === "storefront" && shopId) {
    const { data: codeRow } = await supabaseAdmin
      .from("ussd_shop_codes")
      .select("code")
      .eq("shop_id", shopId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle()
    shopUssdCode = (codeRow?.code as string) ?? null
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  // Split into a byte-stable prefix (cached on Anthropic) and a small per-request tail; see lib/ai-prompts/.
  const today = new Date().toISOString().split("T")[0]   // e.g. 2026-05-22 — recomputed every request
  // Whole knowledge base for the VERIFIED identity's label goes into the stable prefix (all-or-nothing under a char
  // budget). Mirrors get_knowledge_base: 'admin' only after the admin gate above passed, 'dashboard' only with a
  // verified user id, everything else (guests, home, storefront) 'storefront'.
  const knowledgeContext: "home" | "dashboard" | "admin" =
    context === "admin" ? "admin" : context === "dashboard" && userId ? "dashboard" : "home"
  const knowledge = renderKnowledge(await loadKnowledge(supabaseAdmin, knowledgeLabelFor(knowledgeContext)))
  let systemPrompt: ReturnType<typeof buildHomePrompt>
  switch (context) {
    case "home":
      systemPrompt = buildHomePrompt({ ussdDialCode, guestPurchaseUrl, channelNote, knowledge, assistantName: assistantSettings.name, tone: assistantSettings.tone })
      break
    case "storefront":
      systemPrompt = buildStorefrontPrompt({ shopName, storefrontServices, ussdDialCode, shopUssdCode, knowledge, tone: assistantSettings.tone })
      break
    case "dashboard":
      systemPrompt = buildDashboardPrompt({
        knowledge,
        assistantName: assistantSettings.name,
        tone: assistantSettings.tone,
        ussdDialCode,
        channelNote,
        firstName: userContext.firstName,
        lastName: userContext.lastName,
        role: userContext.role,
        phone: userContext.phone,
        balance: userContext.balance,
        today,
        cardNonce,
      })
      break
    case "admin":
      systemPrompt = buildAdminPrompt({
        knowledge,
        assistantName: assistantSettings.name,
        tone: assistantSettings.tone,
        ussdDialCode,
        firstName: userContext.firstName,
        lastName: userContext.lastName,
        today,
        cardNonce,
        adminCatalog: assistantSettings.adminCatalog,
      })
      break
    default:
      return new Response(
        JSON.stringify({ error: "Invalid context" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
  }

  // ── Transcript capture (redacted; after the response, never delays or breaks the chat) ──
  // The final assistant text is only known when the stream ends, so the after() task awaits a promise the stream
  // resolves in its finally. A missing conversationKey (guest widgets that predate keys) gets a fresh one per request.
  let streamText = ""
  let streamErrored = false
  let markStreamDone: () => void = () => {}
  const streamDone = new Promise<void>((resolve) => { markStreamDone = resolve })
  const transcriptKey = conversationKey ?? crypto.randomUUID()
  const captureTranscript = async () => {
    await streamDone
    const extraReasons: FlagReason[] = streamErrored ? ["error"] : []
    await recordTurn(supabaseAdmin, {
      conversationKey: transcriptKey,
      context: context as "home" | "storefront" | "dashboard" | "admin",
      userId: userId ?? null,
      shopId: shopId ?? null,
      userText: transcriptUserText,
      assistantText: streamText,
      extraReasons,
    })
  }
  // Admin chats are never stored (ruling R4); recordTurn refuses them too.
  if (context !== "admin") {
    try {
      after(captureTranscript)
    } catch {
      void captureTranscript() // outside a request scope (tests): a plain un-awaited promise; recordTurn never throws
    }
  }

  // ── Streaming SSE response ────────────────────────────────────────────────
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // A throw from enqueue means the client disconnected; that is not a server error and must not flag the chat.
      let clientGone = false
      const CLIENT_GONE = new Error("client disconnected")
      function trySend(data: Record<string, unknown>) {
        if (clientGone) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          clientGone = true
        }
      }
      // Used by the agent loop: once the client is gone, throw so the loop stops (no more LLM or tool calls).
      function send(data: Record<string, unknown>) {
        trySend(data)
        if (clientGone) throw CLIENT_GONE
      }

      try {
        const toolCtx = {
          userId,
          jwtToken,
          userRole,
          shopId,
          shopSlug,
          baseUrl: getBaseUrl(),
          conversationKey,
        }

        await runAgenticLoop({
          provider: aiProvider,
          model: aiModel,
          system: systemPrompt,
          context,
          messages,
          toolCtx,
          storefrontServices: context === "storefront"
            ? { sellsData, sellsAirtime, sellsResultsChecker: sellsRC }
            : undefined,
          adminCatalog: context === "admin" && assistantSettings.adminCatalog,
          maxTokens: context === "admin" ? 2048 : 1500,
          maxIterations: maxIterationsFor(context, assistantSettings),
          onEvent: (e: Record<string, unknown>) => {
            if (e.type === "text" && typeof e.content === "string") streamText += e.content
            send(e)
          },
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const status = (err as Record<string, unknown>)?.status as number | undefined
        const code = (err as Record<string, unknown>)?.code as string | undefined
        console.error(`[AI-CHAT] provider=${aiProviderName} model=${aiModel} status=${status} code=${code}`, errMsg)

        let msg = "Something went wrong. Please try again."

        const isQuota =
          errMsg.toLowerCase().includes("quota") ||
          errMsg.includes("RESOURCE_EXHAUSTED") ||
          errMsg.toLowerCase().includes("insufficient") ||
          code === "insufficient_quota"

        if (status === 529 || errMsg.toLowerCase().includes("overload")) {
          msg = "The AI service is temporarily overloaded. Please try again in a moment."
        } else if (status === 429 || errMsg.toLowerCase().includes("rate limit")) {
          if (isQuota) {
            msg = `API quota or billing issue with ${aiProviderName === "openai" ? "OpenAI" : aiProviderName === "gemini" ? "Google Gemini" : "the AI provider"}. Add billing or check your quota in Admin → AI Assistant.`
          } else {
            msg = "Too many requests. Please wait a moment and try again."
          }
        } else if (status === 401 || status === 403) {
          msg = `Invalid API key for ${aiProviderName === "openai" ? "OpenAI" : aiProviderName === "gemini" ? "Google Gemini" : "the AI provider"}. Update it in Admin → AI Assistant.`
        } else if (status === 400) {
          msg = "The AI provider rejected the request — check the model and API key in Admin → AI Assistant."
        } else if (status && status >= 500) {
          msg = "The AI service is temporarily unavailable. Please try again shortly."
        }
        // A client that went away is not a server error: only real provider/server failures flag the chat.
        const aborted = clientGone || req.signal.aborted || (err as { name?: string } | null)?.name === "AbortError"
        if (!aborted) streamErrored = true
        if (!streamText && !aborted) streamText = msg
        trySend({ type: "error", content: msg })
      } finally {
        markStreamDone()
        try { controller.close() } catch { /* already closed by a cancel */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
