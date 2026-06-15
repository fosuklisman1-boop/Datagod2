// app/api/whatsapp/webhook/route.ts
import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { getWaSession, setWaSession } from "@/lib/whatsapp-bot/session"
import { waRouter } from "@/lib/whatsapp-bot/router"
import { isResultsCheckAdmin, adminRcRouter } from "@/lib/whatsapp-bot/admin-router"
import { sendWhatsAppText, markWaMessageRead, sendWaTyping, downloadWaMedia } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"
import { maybeNotifyAdmins } from "@/lib/whatsapp-bot/notify-admins"
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

  // Delivery/read status callbacks (sent → delivered → read, or failed) for the
  // messages WE sent. Update the matching row so the inbox shows the right ticks.
  const statuses: any[] = change?.statuses ?? []
  if (statuses.length > 0) {
    await handleStatusUpdates(statuses)
    return
  }

  const messages: any[] = change?.messages ?? []
  if (messages.length === 0) return // other event — ignore

  const msg = messages[0]
  const from: string = msg.from   // e.g. "233559919037"

  // Non-text messages: only meaningful for an admin mid-delivery (photo/PDF of
  // results). Everyone else's media is ignored, as before.
  if (msg.type !== "text") {
    if (!(await isResultsCheckAdmin(from))) return
    const session = await getWaSession(from)
    if (session?.step !== "ADMIN_RC_AWAIT_CONTENT") return

    if (msg.type !== "image" && msg.type !== "document") {
      await sendWhatsAppText(from, "Unsupported file type — please send a photo or PDF.")
      return
    }

    const mediaId = (msg.image ?? msg.document).id
    try {
      const { buffer, mimeType } = await downloadWaMedia(mediaId)
      const ext = mimeType === "application/pdf" ? "pdf" : (mimeType.split("/")[1] ?? "bin")
      const path = `results-check/${session.adminRcSelectedId}-${Date.now()}.${ext}`
      await supabase.storage.from("admin-uploads").upload(path, Buffer.from(buffer), { contentType: mimeType, upsert: true })
      const { data: { publicUrl } } = supabase.storage.from("admin-uploads").getPublicUrl(path)
      await setWaSession(from, {
        ...session,
        adminRcDraftMediaUrl: publicUrl,
        adminRcDraftMediaType: mimeType === "application/pdf" ? "document" : "image",
      })
      await sendWhatsAppText(from, "📎 File received. Reply 'send' to deliver now, or add more text first.")
    } catch (e) {
      console.error("[WA-WEBHOOK] Admin media handling failed:", e)
      await sendWhatsAppText(from, "Sorry, that file couldn't be processed. Please try again.")
    }
    return
  }

  const text: string = msg.text?.body ?? ""
  if (!from || !text.trim()) return

  console.log("[WA-WEBHOOK] Inbound:", { from, text: text.slice(0, 60) })

  // Immediate feedback: fire-and-forget (never block reply processing)
  if (msg.id) void markWaMessageRead(msg.id)
  void sendWaTyping(from)

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

  // Log inbound message (also returns this conversation's takeover state)
  const { humanTakeover, takenOverAt, takenOverBy, conversationCreatedAt } = await logMessage(from, "inbound", text, msg.id)

  // Admin Results Check WhatsApp queue: "pending" (from any state) or mid-flow.
  if (await isResultsCheckAdmin(from)) {
    const adminSession = await getWaSession(from)
    if (
      text.trim().toLowerCase() === "pending" ||
      adminSession?.step === "ADMIN_RC_LIST" ||
      adminSession?.step === "ADMIN_RC_AWAIT_CONTENT"
    ) {
      const reply = await adminRcRouter(from, text, adminSession)
      if (reply) {
        const wamid = await sendWhatsAppText(from, reply)
        await logMessage(from, "outbound", reply, wamid)
      }
      return
    }
  }

  // Push-notify admins when a message needs attention (takeover reply / human
  // request / new chat). Throttled + best-effort inside the helper.
  const takeoverActive = humanTakeover && !!takenOverAt && Date.now() - new Date(takenOverAt).getTime() < 30 * 60 * 1000
  // A returning customer's conversation row has an old (immutable) created_at, so
  // a recent created_at reliably means a first-ever message. Window is generous
  // to tolerate DB latency/clock skew without ever false-positiving.
  const isNewConversation = !!conversationCreatedAt && Date.now() - new Date(conversationCreatedAt).getTime() < 60_000
  await maybeNotifyAdmins({ phone: from, text, takeoverActive, takenOverBy, isNewConversation })

  // Human takeover: an admin owns this chat → bot/AI must not reply. Persistent
  // (DB) flag, auto-expiring after 30 min of admin inactivity (lazy resume). The
  // inbound is already logged above, so the admin still sees it in the inbox.
  if (humanTakeover) {
    const activeMs = takenOverAt ? Date.now() - new Date(takenOverAt).getTime() : Infinity
    if (activeMs < 30 * 60 * 1000) {
      console.log("[WA-WEBHOOK] Human takeover active, bot suppressed:", from)
      return
    }
    // Expired → resume the bot and clear the stale takeover.
    await supabase
      .from("whatsapp_conversations")
      .update({ human_takeover: false, taken_over_by: null, taken_over_at: null })
      .eq("phone_number", from)
  }

  // Route: bot session active → bot router; else → AI
  // waRouter returns '' when the user sent off-script freetext and the session was cleared,
  // signalling that the AI should handle the message naturally.
  const session = await getWaSession(from)
  let reply: string

  if (session) {
    reply = await waRouter(from, text)
    if (reply === '') reply = await handleWithAI(from, text)
  } else {
    reply = await handleWithAI(from, text)
  }

  if (reply) {
    const wamid = await sendWhatsAppText(from, reply)
    await logMessage(from, "outbound", reply, wamid)
  }
}

// Apply Meta delivery/read status callbacks to our outbound rows (matched by
// wamid). Never downgrade from 'read' (a late 'delivered' must not clobber it).
async function handleStatusUpdates(statuses: any[]): Promise<void> {
  for (const s of statuses) {
    const id: string | undefined = s?.id
    const status: string | undefined = s?.status // 'sent' | 'delivered' | 'read' | 'failed'
    if (!id || !status) continue
    try {
      // Only our outbound rows carry ticks; the direction guard also removes any
      // theoretical wamid-namespace collision with an inbound row.
      let q = supabase.from("whatsapp_messages").update({ status }).eq("meta_message_id", id).eq("direction", "outbound")
      if (status !== "read") q = q.neq("status", "read")
      await q
    } catch (e) {
      console.warn("[WA-WEBHOOK] status update failed (non-fatal):", e)
    }
  }
}

// ── AI handler (non-bot messages) ────────────────────────────────────────────

// Map bare main-menu digits to services — same shortcuts USSD users know
const MAIN_MENU_SHORTCUTS: Record<string, string> = {
  "1": "data", "2": "afa", "3": "airtime", "4": "rc",
}

async function handleWithAI(phone: string, text: string): Promise<string> {
  // Fast-path: bare digit 1-4 → start ordering bot directly (no AI needed)
  const shortcut = MAIN_MENU_SHORTCUTS[text.trim()]
  if (shortcut) {
    const { setWaSession } = await import("@/lib/whatsapp-bot/session")
    const { mainMenu, networkMenu, rcMenu, airtimeRecipientPrompt, afaEnterNamePrompt } = await import("@/lib/ussd/menus")
    const localPhone = phone.startsWith("233") ? "0" + phone.slice(3) : phone
    const stepMap: Record<string, { step: string; menu: () => string }> = {
      data:    { step: "SELECT_NETWORK",          menu: networkMenu },
      airtime: { step: "AIRTIME_ENTER_RECIPIENT", menu: airtimeRecipientPrompt },
      afa:     { step: "AFA_ENTER_NAME",           menu: afaEnterNamePrompt },
      rc:      { step: "RC_MENU",                  menu: rcMenu },
    }
    const mapped = stepMap[shortcut]
    await setWaSession(phone, { step: mapped.step as any, dialingPhone: localPhone })
    return mapped.menu()
  }

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

  const system = `You are the Datagod assistant on WhatsApp. Datagod is a Ghanaian platform for mobile data bundles, airtime, AFA registration, and exam results services.

SERVICES:
- Data bundles: MTN, Telecel, AirtelTigo — instant delivery after payment
- Airtime top-up: any Ghana network
- AFA registration: Ghana government agricultural program registration
- Results Checker Vouchers: buy WASSCE/BECE/NOVDEC voucher codes — customer checks their own results on the WAEC portal
- Results Check Service: Datagod checks exam results on the customer's behalf — customer provides their index number, date of birth, exam year, exam board, and a WhatsApp number to receive results. Two modes: "Combo" (Datagod supplies the voucher, higher fee) or "Own Voucher" (customer already has a PIN and serial, lower fee). Results delivered directly to their WhatsApp.

The user's WhatsApp number is ${phone}${userId ? " and they have a registered Datagod account" : ""}.

When the user wants to order anything (data bundle, airtime, AFA, voucher, or Results Check Service): call start_ordering_bot. Use service="rc" for both voucher purchases AND the Results Check Service — the menu lets them pick. Never describe menu options in text.
For support, order status, and general questions: answer directly.`

  let result: { text: string; toolsUsed: string[] }
  try {
    result = await runAgenticLoop({
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
  } catch (e) {
    console.error("[WA-WEBHOOK] runAgenticLoop error:", e)
    return "I'm having trouble right now. Please try again in a moment."
  }

  // If start_ordering_bot was called THIS run, show the correct submenu immediately.
  // (Do NOT check for arbitrary existing sessions — that would catch stale post-purchase sessions.)
  if (result.toolsUsed.includes("start_ordering_bot")) {
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
  }

  return result.text || "I'm here to help!\n\nReply with:\n- *data* to buy data bundles\n- *airtime* for airtime top-up\n- *afa* for AFA registration\n- *rc* for results checker vouchers"
}

