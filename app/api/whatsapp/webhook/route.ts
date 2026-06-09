// app/api/whatsapp/webhook/route.ts
import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { getWaSession } from "@/lib/whatsapp-bot/session"
import { waRouter } from "@/lib/whatsapp-bot/router"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { resolveProviderForContext, DEFAULT_CONFIG, AIProviderConfig } from "@/lib/ai-providers"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function verifyMetaSignature(request: NextRequest, rawBody: string): Promise<boolean> {
  const sig = request.headers.get("x-hub-signature-256")
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!sig || !secret) return false
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  try {
    return sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))
  } catch {
    return false
  }
}

// ── GET: Meta webhook verification ───────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[WA-WEBHOOK] Webhook verified")
    return new Response(challenge ?? "", { status: 200 })
  }
  return new Response("Forbidden", { status: 403 })
}

// ── POST: Inbound message ─────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  if (!(await verifyMetaSignature(request, rawBody))) {
    console.warn("[WA-WEBHOOK] Signature verification failed")
    return new Response("Forbidden", { status: 403 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ status: "ok" }, { status: 200 })
  }

  // Return 200 immediately — Meta requires a response within 5 s
  after(async () => {
    try {
      await processInbound(body)
    } catch (e) {
      console.error("[WA-WEBHOOK] processInbound error:", e)
    }
  })

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ── Core processing ───────────────────────────────────────────────────────────

async function processInbound(body: unknown): Promise<void> {
  const entry = (body as any)?.entry?.[0]
  const change = entry?.changes?.[0]?.value
  const messages: any[] = change?.messages ?? []
  if (messages.length === 0) return // status update or other event — ignore

  const msg = messages[0]
  if (msg.type !== "text") return // ignore non-text (images, reactions, etc.)

  const from: string = msg.from   // e.g. "233559919037"
  const text: string = msg.text?.body ?? ""
  if (!from || !text.trim()) return

  console.log("[WA-WEBHOOK] Inbound:", { from, text: text.slice(0, 60) })

  // Dedup: skip if we already processed this Meta message ID
  if (msg.id) {
    const { count } = await supabase
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("meta_message_id", msg.id)
    if ((count ?? 0) > 0) {
      console.log("[WA-WEBHOOK] Duplicate message, skipping:", msg.id)
      return
    }
  }

  // Log inbound message
  await logMessage(from, "inbound", text, msg.id)

  // Route: bot session active → bot router; else → AI
  const session = await getWaSession(from)
  let reply: string

  if (session) {
    reply = await waRouter(from, text)
  } else {
    reply = await handleWithAI(from, text)
  }

  if (reply) {
    await sendWhatsAppText(from, reply)
    await logMessage(from, "outbound", reply, null)
  }
}

// ── AI handler (non-bot messages) ────────────────────────────────────────────

async function handleWithAI(phone: string, text: string): Promise<string> {
  // Load AI config
  let aiConfig: AIProviderConfig = DEFAULT_CONFIG
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "ai_provider_config")
      .maybeSingle()
    if (data?.value) aiConfig = data.value as AIProviderConfig
  } catch {}

  const { provider, model } = resolveProviderForContext("whatsapp", aiConfig)

  // Load matched user (if phone is a registered Datagod user)
  let userId: string | undefined
  const localPhone = phone.startsWith("233") ? "0" + phone.slice(3) : phone
  try {
    const { data: userRow } = await supabase
      .from("users")
      .select("id")
      .eq("phone_number", localPhone)
      .maybeSingle()
    userId = userRow?.id
  } catch {}

  // Load last 20 messages for conversation history
  const { data: history } = await supabase
    .from("whatsapp_messages")
    .select("direction, message")
    .eq("phone_number", phone)
    .in("direction", ["inbound", "outbound"])
    .order("created_at", { ascending: false })
    .limit(20)

  const messages: Array<{ role: "user" | "assistant"; content: string }> = (history ?? [])
    .reverse()
    .filter(m => m.message)
    .map(m => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.message! }))

  // Append current message
  messages.push({ role: "user", content: text })

  const system = `You are the Datagod assistant on WhatsApp. Datagod is a data bundle reseller in Ghana.
You help users with: buying data bundles, airtime, AFA registration, and results checker vouchers.
The user's WhatsApp number is ${phone}${userId ? " and they have a registered Datagod account" : ""}.
When the user wants to buy something, call the start_ordering_bot tool — do not describe menus in text.
For support questions, order status, and account queries, answer directly.`

  const result = await runAgenticLoop({
    provider,
    model,
    system,
    context: "whatsapp",
    messages,
    toolCtx: {
      userId,
      userRole: userId ? "dashboard" : "guest",
      baseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    },
    maxIterations: 5,
    maxTokens: 600,
  })

  // If the AI called start_ordering_bot, a session now exists.
  // Always show the bot's menu for the session step — ignore any AI conversational text.
  const newSession = await getWaSession(phone)
  if (newSession) {
    const { mainMenu, networkMenu, rcMenu, airtimeRecipientPrompt, afaEnterNamePrompt } = await import("@/lib/ussd/menus")
    const stepMenus: Partial<Record<string, () => string>> = {
      SELECT_NETWORK:          networkMenu,
      AIRTIME_ENTER_RECIPIENT: airtimeRecipientPrompt,
      AFA_ENTER_NAME:          afaEnterNamePrompt,
      RC_MENU:                 rcMenu,
    }
    const menuFn = stepMenus[newSession.step]
    return menuFn ? menuFn() : mainMenu()
  }
  return result.text
}

// ── DB logging ────────────────────────────────────────────────────────────────

async function logMessage(
  phone: string,
  direction: "inbound" | "outbound",
  message: string,
  metaMessageId: string | null
): Promise<void> {
  try {
    // Upsert conversation record
    const { data: conv } = await supabase
      .from("whatsapp_conversations")
      .upsert({ phone_number: phone }, { onConflict: "phone_number" })
      .select("id")
      .maybeSingle()

    const conversationId = conv?.id ?? null

    await supabase.from("whatsapp_messages").insert({
      conversation_id: conversationId,
      direction,
      phone_number: phone,
      message,
      meta_message_id: metaMessageId,
      status: "sent",
    })

    // Update conversation preview
    const updatePayload: Record<string, unknown> = {
      last_message_preview: message.slice(0, 100),
      updated_at: new Date().toISOString(),
    }
    if (direction === "inbound") updatePayload.latest_inbound_at = new Date().toISOString()
    else updatePayload.latest_outbound_at = new Date().toISOString()

    if (conversationId) {
      await supabase.from("whatsapp_conversations")
        .update(updatePayload)
        .eq("id", conversationId)
    }
  } catch (e) {
    console.warn("[WA-WEBHOOK] logMessage failed (non-fatal):", e)
  }
}
