// app/api/whatsapp/webhook/route.ts
import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { getWaSession, setWaSession } from "@/lib/whatsapp-bot/session"
import { waRouter } from "@/lib/whatsapp-bot/router"
import { isResultsCheckAdmin, adminRcRouter, adminComplaintRouter } from "@/lib/whatsapp-bot/admin-router"
import { sendWhatsAppText, markWaMessageRead, sendWaTyping, downloadWaMedia, formatForWhatsApp } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"
import { maybeNotifyAdmins, isHumanRequest } from "@/lib/whatsapp-bot/notify-admins"
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

  // The sender's WhatsApp display name (Cloud API gives the name, not a photo).
  const contacts: any[] = change?.contacts ?? []
  const profileName: string | null =
    contacts.find((c) => c?.wa_id === from)?.profile?.name ?? contacts[0]?.profile?.name ?? null

  // Non-text messages: meaningful for (a) an admin mid-results-delivery, or
  // (b) a customer sending a screenshot for their recent complaint. Otherwise ignored.
  if (msg.type !== "text") {
    const isAdmin = await isResultsCheckAdmin(from)

    // (a) Admin attaching the results photo/PDF mid-delivery.
    if (isAdmin) {
      const session = await getWaSession(from)
      if (session?.step === "ADMIN_RC_AWAIT_CONTENT") {
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
      // Admin not mid-delivery → fall through to the normal customer media handling
      // below. An admin number can also act as a customer (testing, or buying for
      // themselves) — their screenshot / complaint proof must NOT be silently dropped.
    }

    // (b) Customer media → log it to the inbox thread so admins can see it (this
    // was previously dropped unless it was an image/PDF for an open complaint), and
    // still attach images/PDFs to a recent open complaint as evidence.
    const mediaNode = msg.image ?? msg.video ?? msg.document ?? msg.audio ?? msg.sticker
    const mediaId: string | undefined = mediaNode?.id
    if (!mediaId) return // a non-media, non-text type we don't handle (location, reaction, …)

    // Media skips the text-path dedup below, so guard duplicates here too.
    if (msg.id) {
      const { count } = await supabase
        .from("whatsapp_messages")
        .select("id", { count: "exact", head: true })
        .eq("meta_message_id", msg.id)
      if ((count ?? 0) > 0) return
    }

    try {
      const { buffer, mimeType: rawMime } = await downloadWaMedia(mediaId)
      // WhatsApp reports params like "audio/ogg; codecs=opus" — strip them so the
      // content-type matches the storage MIME allowlist and the extension is clean.
      const mimeType = rawMime.split(";")[0].trim().toLowerCase()
      const isImage = mimeType.startsWith("image/")
      const caption: string = String(mediaNode.caption ?? "").trim()
      const MEDIA_EXT: Record<string, string> = {
        "application/pdf": "pdf", "text/plain": "txt",
        "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/opus": "opus", "audio/aac": "aac", "audio/amr": "amr",
        "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
      }
      let bytes: Uint8Array = new Uint8Array(buffer)
      let storeMime = mimeType
      let ext = MEDIA_EXT[mimeType] ?? (mimeType.split("/")[1]?.split("+")[0] ?? "bin")

      // Voice notes are Opus/Ogg, which Safari can't play. Transcode to MP3 on
      // arrival so they play everywhere (our admins are mostly on Safari). Other
      // audio (mp3/aac/m4a) plays natively, so it's left alone. Falls back to the
      // original bytes if the transcode fails.
      if (mimeType === "audio/ogg" || mimeType === "audio/opus") {
        try {
          const { opusOggToMp3 } = await import("@/lib/audio-transcode")
          bytes = await opusOggToMp3(new Uint8Array(buffer))
          storeMime = "audio/mpeg"
          ext = "mp3"
          console.log("[WA-WEBHOOK] Transcoded voice note to MP3:", bytes.length, "bytes")
        } catch (e) {
          console.warn("[WA-WEBHOOK] voice note transcode failed, storing original:", e instanceof Error ? e.message : String(e))
        }
      }

      // Non-enumerable, PII-free path (public bucket — no phone in the URL).
      const path = `inbox/${crypto.randomUUID()}.${ext}`
      await supabase.storage.from("admin-uploads").upload(path, Buffer.from(bytes), { contentType: storeMime, upsert: true })
      const { data: { publicUrl } } = supabase.storage.from("admin-uploads").getPublicUrl(path)

      // Surface it in the admin inbox thread. media_type drives the bubble:
      // image renders inline, video/audio play inline, anything else is a link.
      const displayType =
        isImage ? "image" :
        mimeType.startsWith("video/") ? "video" :
        mimeType.startsWith("audio/") ? "audio" :
        "document"
      const typeLabel =
        isImage ? "📷 Photo" :
        msg.type === "video" ? "🎥 Video" :
        msg.type === "audio" ? "🎤 Voice note" :
        msg.type === "sticker" ? "🌟 Sticker" :
        "📄 Document"
      await logMessage(from, "inbound", caption || typeLabel, msg.id, { url: publicUrl, type: displayType }, profileName)

      // Complaint proof (screenshots/PDF only — not voice notes/videos).
      if (isImage || mimeType === "application/pdf") {
        const { getPendingComplaint, clearPendingComplaint } = await import("@/lib/whatsapp-bot/pending-complaint")
        const pending = await getPendingComplaint(from)
        const { createComplaint, findRecentOpenComplaint, appendComplaintEvidence, notifyAdminsNewComplaint } =
          await import("@/lib/whatsapp-bot/complaints")
        if (pending) {
          // A complaint was staged awaiting proof → submit it NOW with this
          // screenshot, then alert admins (so they receive a complete complaint,
          // never a bare one before the proof).
          const res = await createComplaint(from, pending.summary, {
            customerName: profileName,
            beneficiaryNumber: pending.beneficiaryNumber,
            orderInfo: pending.orderInfo,
            category: pending.category,
          })
          if (res && "complaint" in res) {
            await appendComplaintEvidence(res.complaint.id, publicUrl)
            if (res.isNew) await notifyAdminsNewComplaint(res.complaint)
            await clearPendingComplaint(from)
            await sendWhatsAppText(from, `✅ Complaint submitted with your screenshot (ref: ${res.complaint.id.slice(0, 8).toUpperCase()}). Our team will get back to you here shortly.`)
          } else if (res && "rateLimited" in res) {
            await clearPendingComplaint(from)
            await sendWhatsAppText(from, "Thanks — we've received your screenshot, but you've reached today's complaint limit. Our team can still see this conversation.")
          }
          // else (transient error): leave it staged so the next screenshot retries.
        } else {
          // No staged complaint → attach to a recent open/claimed complaint (e.g. an
          // extra screenshot for one already submitted).
          const open = await findRecentOpenComplaint(from)
          if (open) {
            const added = await appendComplaintEvidence(open.id, publicUrl)
            await sendWhatsAppText(from, added
              ? "📎 Screenshot added to your complaint — our team will review it. Thank you."
              : "Thanks — we already have several screenshots for this complaint, so the team has enough to review it.")
          }
        }
      }
    } catch (e) {
      console.error("[WA-WEBHOOK] Customer media handling failed:", e)
      // Don't leave the admin blind — record that something came in.
      try { await logMessage(from, "inbound", `📎 ${msg.type ?? "media"} (couldn't be loaded)`, msg.id, null, profileName) } catch {}
    }
    return
  }

  const text: string = msg.text?.body ?? ""
  if (!from || !text.trim()) return

  console.log("[WA-WEBHOOK] Inbound:", { from, text: text.slice(0, 60) })

  // Immediate feedback: fire-and-forget (never block reply processing)
  if (msg.id) void markWaMessageRead(msg.id)

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
  const { humanTakeover, takenOverAt, takenOverBy, conversationCreatedAt } = await logMessage(from, "inbound", text, msg.id, null, profileName)

  // Per-sender inbound cap: a spammer flooding the bot would otherwise burn AI
  // tokens on every message. Inbound is already logged (visible in the inbox);
  // we just stop the expensive bot/AI processing for over-the-limit senders.
  const { allowInbound } = await import("@/lib/whatsapp-bot/rate-limit")
  if (!(await allowInbound(from))) {
    console.warn("[WA-WEBHOOK] Inbound rate limit hit, dropping:", from)
    return
  }

  // "unlink" — customer removes the link between this WhatsApp number and a
  // Datagod account (the persistent link created via OTP verification).
  if (text.trim().toLowerCase() === "unlink") {
    const { unlinkWhatsApp } = await import("@/lib/whatsapp-bot/account-link")
    const removed = await unlinkWhatsApp(from)
    const reply = removed
      ? "Done — this WhatsApp number is no longer linked to a Datagod account."
      : "This WhatsApp number isn't linked to any Datagod account."
    const out = formatForWhatsApp(reply)
    const wamid = await sendWhatsAppText(from, out)
    await logMessage(from, "outbound", out, wamid)
    return
  }

  // Admin WhatsApp queues: Results Check ("pending") and complaints ("complaints"),
  // from the keyword or mid-flow. Both are reserved for configured admin numbers.
  if (await isResultsCheckAdmin(from)) {
    const adminSession = await getWaSession(from)
    const lc = text.trim().toLowerCase()
    const isRc = lc === "pending" || adminSession?.step === "ADMIN_RC_LIST" || adminSession?.step === "ADMIN_RC_AWAIT_CONTENT"
    const isComplaint = lc === "complaints" || adminSession?.step === "ADMIN_COMPLAINT_LIST" || adminSession?.step === "ADMIN_COMPLAINT_AWAIT_REPLY"
    if (isRc || isComplaint) {
      const reply = isRc
        ? await adminRcRouter(from, text, adminSession)
        : await adminComplaintRouter(from, text, adminSession)
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

  // Customer asking for a human → flag the conversation (the bot keeps replying;
  // the flag is a queue marker for admins, cleared when an admin engages). Skip
  // if an admin is already on it.
  const humanRequest = isHumanRequest(text)
  if (humanRequest && !takeoverActive) {
    await supabase
      .from("whatsapp_conversations")
      .update({ wants_human: true, wants_human_at: new Date().toISOString() })
      .eq("phone_number", from)
  }

  await maybeNotifyAdmins({ phone: from, text, takeoverActive, takenOverBy, isNewConversation, humanRequest })

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

  // The bot is going to reply (we're past the takeover/admin/rate-limit gates) →
  // show the "typing…" indicator so the wait for the AI feels responsive. It
  // auto-dismisses when we send the reply below (or after ~25s). Fire-and-forget.
  if (msg.id) void sendWaTyping(msg.id)

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
    const out = formatForWhatsApp(reply) // Markdown (**bold**) → WhatsApp (*bold*)
    const wamid = await sendWhatsAppText(from, out)
    await logMessage(from, "outbound", out, wamid)
  }
}

// Apply Meta delivery/read status callbacks to our outbound rows (matched by
// wamid). Never downgrade from 'read' (a late 'delivered' must not clobber it).
async function handleStatusUpdates(statuses: any[]): Promise<void> {
  for (const s of statuses) {
    const id: string | undefined = s?.id
    const status: string | undefined = s?.status // 'sent' | 'delivered' | 'read' | 'failed'
    if (!id || !status) continue
    // Surface delivery failures (e.g. 131047 re-engagement, 131053 media error) —
    // previously these callbacks were swallowed, so a message that WhatsApp
    // accepted (200) then dropped left no trace of why.
    if (status === "failed") {
      const err = Array.isArray(s?.errors) ? s.errors[0] : null
      console.error("[WA-WEBHOOK] Outbound message FAILED:", id, "code=", err?.code, "title=", err?.title, "detail=", err?.error_data?.details ?? err?.message ?? "")
    }
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

async function handleWithAI(phone: string, text: string): Promise<string> {
  // NOTE: there is deliberately NO bare-digit fast-path here. A lone "1" used to
  // immediately start data ordering regardless of context, so a customer answering
  // a question (or mid-complaint) with "1" got hijacked into an order. The AI now
  // decides — it has the full conversation and starts an order only on real intent.

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

  // Load matched user: the WhatsApp number IS a registered number, or it was
  // verified-and-linked to an account (see account-verify.ts).
  let userId: string | undefined
  const localPhone = phone.startsWith("233") ? "0" + phone.slice(3) : phone
  try {
    const { data: userRow } = await supabase
      .from("users")
      .select("id")
      .eq("phone_number", localPhone)
      .maybeSingle()
    userId = userRow?.id
    if (!userId) {
      const { resolveLinkedUserId } = await import("@/lib/whatsapp-bot/account-link")
      userId = (await resolveLinkedUserId(phone)) ?? undefined
    }
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

  // Shareable links the bot can offer in conversation.
  const siteUrl = process.env.NEXT_PUBLIC_APP_URL || ""
  let channelLink = ""
  try {
    const { data: appSettings } = await supabase.from("app_settings").select("join_community_link").limit(1).maybeSingle()
    channelLink = (appSettings?.join_community_link as string) || ""
  } catch {}
  const linksSection = [
    siteUrl ? `- Website: ${siteUrl} — browse packages, buy online, top up the wallet, or manage the account.` : "",
    channelLink ? `- WhatsApp channel (updates, new bundles & deals): ${channelLink}` : "",
  ].filter(Boolean).join("\n")

  const baseSystem = `You are the Datagod assistant on WhatsApp. Datagod is a Ghanaian platform for mobile data bundles, airtime, AFA registration, exam results services, and customer support.

SERVICES:
- Data bundles: MTN, Telecel, AirtelTigo — instant delivery after payment
- Airtime top-up: any Ghana network
- AFA registration: Ghana government agricultural program registration
- Results Checker Vouchers: buy WASSCE/BECE/NOVDEC voucher codes — the customer checks their own results on the WAEC portal
- Results Check Service: Datagod checks exam results on the customer's behalf — they provide index number, date of birth, exam year, exam board and a WhatsApp number; results are delivered to them. Two modes: "Combo" (Datagod supplies the voucher, higher fee) or "Own Voucher" (customer already has a PIN + serial, lower fee).
- Help & support: track an order, fix a stuck wallet top-up, verify/link an account, or report a problem / file a complaint (e.g. paid but didn't receive, wrong bundle, charged twice) — just tell me what's wrong.

The user's WhatsApp number is ${phone}${userId ? " and they have a registered Datagod account" : ""}.
${linksSection ? `\nLINKS (share as plain URLs when it helps — the channel when they ask about updates/deals or want to stay informed; the website for browsing, buying online, or self-service):\n${linksSection}\n` : ""}
GREETING / "what can you do": when you greet someone or they ask what you can help with, briefly cover the full range — buy data, airtime, AFA, results checker; check exam results; track an order; sort out a wallet top-up; AND report a problem/complaint — and feel free to point them to the website or WhatsApp channel.

ORDERING:
- When the customer clearly wants to BUY/order something (data, airtime, AFA, voucher, or the Results Check Service), call start_ordering_bot. Use service="rc" for both voucher purchases and the Results Check Service — the menu lets them pick. Never type menu options yourself.
- A customer who sends ONLY a menu digit as a fresh choice (their first message, or right after you offered the menu) means: 1 = data, 2 = AFA, 3 = airtime, 4 = results checker — call start_ordering_bot for that service.
- BUT do NOT start an order just because the customer sent a phone number, an amount, or a bare digit in the MIDDLE of another topic (answering a question you asked, giving complaint details, providing a beneficiary number, etc.). Read the conversation and treat the number as the answer to what you were discussing. If a lone number's meaning is genuinely unclear, ask what they'd like to do — do not assume they want to buy data.

ANSWERING QUESTIONS — use your tools, never guess:
- Prices/packages → call get_available_packages and quote the real price. Never invent a price or bundle.
- "Where is my order" / order status / "did my payment go through" → call search_order_status with their reference or order id.
- A registered user asking about their wallet or past orders → get_wallet_balance / get_order_history.
- Delivery times, payment, refunds, AFA details, "how does X work", or any policy/process question → call get_knowledge_base BEFORE answering; do not invent policies.
- Payment is via Paystack — mobile money (MoMo) or card; registered users can also pay from their Datagod wallet. Data is usually delivered instantly (occasionally a few minutes at peak).

REPORTING A PROBLEM / COMPLAINTS:
- If the customer reports a real problem or wants to complain, first work out the category, gather the right details (one short message asking for what's missing — don't interrogate), then call file_complaint with phone, a clear summary, the category, and beneficiary_number + order_info. NOTE: file_complaint only CAPTURES the details — the complaint is submitted to the team and logged ONLY once the customer sends a screenshot/photo (mandatory). Never tell them it's already logged before they send it.
  • data / airtime not received or wrong → ask the beneficiary number (the number meant to receive it) and what they ordered (network + bundle/amount, roughly when). category "data" or "airtime".
  • WALLET TOP-UP didn't reflect / paid but balance not credited → FIRST call reverify_payment. It re-checks Paystack and instantly credits any genuinely-successful stuck top-up (safe, idempotent). Then relay the tool's outcome (credited + new balance / still pending / payment failed / nothing found). If NOTHING was found, the deposit was likely made into a DIFFERENT account, or their Datagod account is registered under another phone number. So your FIRST follow-up question must be: "Did you make the deposit under a different phone number, or is your Datagod account registered with a different number?" — NOT a request for a transaction reference. If they used a different number, verify that account (see below) and reverify again. Only once you're sure it's the SAME account should you ask for a Paystack reference / Momo transaction ID and call reverify_payment again with it before considering a complaint.
    – Verifying an account (use whenever the right account may be under a different number, or reverify_payment returns no_account): ask for the phone number ON the Datagod account, call start_account_verification, then ask for the 6-digit code and call verify_account_code. IMPORTANT: the code is sent by SMS to the NUMBER ON THAT ACCOUNT — the number they're proving they own — which is usually NOT their WhatsApp number. Tell them to check the SMS on that account's phone and refer to it by the masked digits the tool returns (e.g. "ending 9037"). NEVER tell them the code went to their WhatsApp number. Once verified, call reverify_payment again — it now checks the verified account and will find + credit the top-up. (If they can't get the code, fall back to /dashboard/payment-reverify or logging a complaint.)
    – Only if it still can't be resolved (pending, nothing found and they insist they paid, or not linked and they can't message from their account number) — file a complaint. To gather details, look at what they've ALREADY told you and ask, in ONE short message, only for what's still missing: the amount, the MoMo number they paid from, and roughly when. The Paystack reference and the network are OPTIONAL — do not insist on them or keep asking. As SOON as you have the amount + MoMo number + rough time, call file_complaint immediately (category "wallet_topup"; put the amount, MoMo number, time and any reference into order_info) — do not keep asking more questions. Then ask for the payment screenshot.
  • results-check issue → category "results"; AFA → "afa"; anything else → "other".
- After calling file_complaint, the complaint is NOT logged yet — a screenshot is mandatory. Apologise and ask for it, e.g.: "Sorry about that — almost done. Please send a screenshot of your payment (or a photo of the issue) here to submit your complaint." It is logged and the team alerted the moment they send it (they'll get a reference then — the system handles that, you don't need to). If they say they have no screenshot or can't send one, call request_human_handoff instead — we don't log a complaint without proof, but never dead-end them.

ESCALATING TO THE TEAM (always-available fallback — never dead-end):
- Call request_human_handoff whenever ANY of these is true: the customer asks for a human/agent/admin/manager or to "escalate"; they're upset or frustrated; you genuinely cannot resolve or answer their issue; or you've gone back and forth without making progress. Then reassure them: a team member has been notified and will reply right here on WhatsApp shortly.
- NEVER say "I can't help", "I'm unable to assist", or send them elsewhere and stop. If you're stuck, escalate — the team picks it up in this same chat. When unsure whether you can solve it, offer: "Would you like me to connect you to our team?" and escalate if they say yes.
- (file_complaint only stages a complaint; the team is alerted once the customer's screenshot submits it. Use request_human_handoff for general "get a person on this" situations, or when a customer genuinely can't provide a screenshot for their complaint.)

STYLE:
- Keep replies short and friendly for WhatsApp. Use *bold* sparingly for prices/keywords, one idea per line. Never mention tools, functions, or internal details.
- Don't loop or interrogate: NEVER ask for a detail the customer already gave (re-read the conversation first), and ask for any missing details together in one short message rather than one at a time. Once you have enough to act (e.g. enough to file a complaint), act — don't keep asking more questions. When you say you'll do something ("let me log this"), actually call the tool in that same turn.`

  // If a complaint is already staged and waiting on the customer's screenshot,
  // steer the AI to require it (and not re-file the same complaint).
  const { getPendingComplaint } = await import("@/lib/whatsapp-bot/pending-complaint")
  const hasPendingComplaint = await getPendingComplaint(phone)
  const system = hasPendingComplaint
    ? `${baseSystem}\n\nPENDING COMPLAINT — IMPORTANT: A complaint is already captured for this customer and is waiting ONLY for their photo/screenshot to be submitted. Do NOT call file_complaint again. In one short line, remind them to send the screenshot here so it can be submitted. If they say they cannot send one, call request_human_handoff (we never log a complaint without proof).`
    : baseSystem

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
        phone, // authoritative sender (233…) so complaint/handoff key matches inbound media
      },
      maxIterations: 5,
      maxTokens: 600,
    })
  } catch (e) {
    console.error("[WA-WEBHOOK] runAgenticLoop error:", e)
    // The assistant itself failed — don't dead-end. Escalate to admins (flag the
    // chat for the inbox + push) so a human can pick it up.
    try {
      const { flagAndNotifyHumanRequest } = await import("@/lib/whatsapp-bot/notify-admins")
      await flagAndNotifyHumanRequest(phone)
    } catch {}
    return "Sorry, I'm having trouble right now — I've alerted our team and someone will get back to you here shortly."
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

  return result.text || `I'm here to help! 😊\n\nReply with:\n- *data* to buy data bundles\n- *airtime* for airtime top-up\n- *afa* for AFA registration\n- *rc* for results checker / results service\n- *order* to track an order\n- *help* to report a problem or complaint${channelLink ? `\n\nUpdates & deals: ${channelLink}` : ""}`
}

