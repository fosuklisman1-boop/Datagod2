import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { normalizePhoneToE164 } from "@/lib/phone-validation"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0"
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
const DEFAULT_TEMPLATE = process.env.WHATSAPP_NOTIFICATION_TEMPLATE || "datagod_utility_alert"
const DEFAULT_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US"
const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000

export interface SendWhatsAppResult {
  success: boolean
  messageId?: string
  error?: string
  mode?: "text" | "template"
}

interface LogWhatsAppMessageInput {
  conversationId?: string
  direction: "inbound" | "outbound" | "status"
  phone: string
  message?: string
  metaMessageId?: string
  status?: string
  error?: string
  toolContext?: Record<string, unknown>
}

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET
  if (!appSecret) return true
  if (!signatureHeader?.startsWith("sha256=")) return false

  const expected = `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex")}`

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

export async function logWhatsAppMessage(input: LogWhatsAppMessageInput): Promise<void> {
  try {
    await supabase.from("whatsapp_messages").insert({
      conversation_id: input.conversationId ?? null,
      direction: input.direction,
      phone_number: normalizePhoneToE164(input.phone),
      message: input.message ?? null,
      meta_message_id: input.metaMessageId ?? null,
      status: input.status ?? "sent",
      error_message: input.error ?? null,
      tool_context: input.toolContext ?? null,
    })
  } catch (err) {
    console.warn("[WHATSAPP] Failed to log message:", err)
  }
}

export async function isWithinWhatsAppConversationWindow(phone: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("whatsapp_conversations")
      .select("latest_inbound_at")
      .eq("phone_number", normalizePhoneToE164(phone))
      .maybeSingle()

    if (!data?.latest_inbound_at) return false
    return Date.now() - new Date(data.latest_inbound_at).getTime() < CONVERSATION_WINDOW_MS
  } catch {
    return false
  }
}

async function postToMeta(body: Record<string, unknown>): Promise<SendWhatsAppResult> {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    return { success: false, error: "WhatsApp Cloud API is not configured" }
  }

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    const messageId = data?.messages?.[0]?.id

    if (!res.ok) {
      return {
        success: false,
        error: data?.error?.message ?? "WhatsApp send failed",
      }
    }

    return { success: true, messageId }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "WhatsApp send failed",
    }
  }
}

export async function sendWhatsAppText(params: {
  phone: string
  message: string
  conversationId?: string
  reference?: string
  skipLogging?: boolean
}): Promise<SendWhatsAppResult> {
  const to = normalizePhoneToE164(params.phone).replace("+", "")
  const result = await postToMeta({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: params.message.slice(0, 4096),
    },
  })

  if (!params.skipLogging) {
    await logWhatsAppMessage({
      conversationId: params.conversationId,
      direction: "outbound",
      phone: params.phone,
      message: params.message,
      metaMessageId: result.messageId,
      status: result.success ? "sent" : "failed",
      error: result.error,
      toolContext: params.reference ? { reference: params.reference, mode: "text" } : { mode: "text" },
    })
  }

  return { ...result, mode: "text" }
}

export async function sendWhatsAppTemplate(params: {
  phone: string
  templateName?: string
  languageCode?: string
  bodyParams?: string[]
  conversationId?: string
  reference?: string
  skipLogging?: boolean
}): Promise<SendWhatsAppResult> {
  const to = normalizePhoneToE164(params.phone).replace("+", "")
  const bodyParams = params.bodyParams ?? []
  const result = await postToMeta({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: params.templateName ?? DEFAULT_TEMPLATE,
      language: { code: params.languageCode ?? DEFAULT_TEMPLATE_LANG },
      ...(bodyParams.length
        ? {
            components: [{
              type: "body",
              parameters: bodyParams.map(text => ({ type: "text", text: text.slice(0, 1024) })),
            }],
          }
        : {}),
    },
  })

  if (!params.skipLogging) {
    await logWhatsAppMessage({
      conversationId: params.conversationId,
      direction: "outbound",
      phone: params.phone,
      message: bodyParams.join(" | "),
      metaMessageId: result.messageId,
      status: result.success ? "sent" : "failed",
      error: result.error,
      toolContext: {
        reference: params.reference,
        mode: "template",
        template: params.templateName ?? DEFAULT_TEMPLATE,
      },
    })
  }

  return { ...result, mode: "template" }
}

export async function sendWhatsAppNotification(params: {
  phone: string
  title: string
  body: string
  reference?: string
  templateName?: string
  userId?: string
}): Promise<SendWhatsAppResult> {
  const message = params.title ? `${params.title}: ${params.body}` : params.body
  const insideWindow = await isWithinWhatsAppConversationWindow(params.phone)

  if (insideWindow) {
    return sendWhatsAppText({
      phone: params.phone,
      message,
      reference: params.reference,
    })
  }

  return sendWhatsAppTemplate({
    phone: params.phone,
    templateName: params.templateName,
    bodyParams: [params.title, params.body],
    reference: params.reference,
  })
}
