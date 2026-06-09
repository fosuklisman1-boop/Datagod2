// lib/whatsapp-bot/send.ts
const GRAPH_API_VERSION = "v25.0"

function baseHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
}

export async function markWaMessageRead(messageId: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!phoneNumberId || !token) return
  try {
    await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: baseHeaders(token),
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    })
  } catch {}
}

export async function sendWaTyping(to: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!phoneNumberId || !token) return
  try {
    await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: baseHeaders(token),
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "typing" }),
    })
  } catch {}
}

export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN

  if (!phoneNumberId || !token) {
    console.error("[WA-SEND] WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set")
    return
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error("[WA-SEND] API error:", res.status, err)
      return
    }
  } catch (e) {
    console.error("[WA-SEND] fetch error:", e)
  }
}
