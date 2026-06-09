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

// Upload a file to WhatsApp's media endpoint and return the media_id.
// WhatsApp doesn't accept arbitrary hosted URLs — you must upload first.
async function uploadMediaToWhatsApp(
  phoneNumberId: string,
  token: string,
  fileUrl: string,
  mimeType: string,
): Promise<string> {
  // Fetch the file from storage
  const fileRes = await fetch(fileUrl)
  if (!fileRes.ok) throw new Error(`Failed to fetch media from storage (${fileRes.status})`)
  const fileBuffer = await fileRes.arrayBuffer()

  // Upload to WhatsApp media API as multipart/form-data
  const formData = new FormData()
  formData.append("messaging_product", "whatsapp")
  formData.append("type", mimeType)
  const ext = fileUrl.split(".").pop()?.split("?")[0] ?? "bin"
  formData.append("file", new Blob([fileBuffer], { type: mimeType }), `upload.${ext}`)

  const uploadRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData },
  )
  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error(`WhatsApp media upload failed (${uploadRes.status}): ${err}`)
  }
  const { id } = await uploadRes.json() as { id: string }
  if (!id) throw new Error("WhatsApp media upload returned no id")
  return id
}

export async function sendWhatsAppMedia(
  to: string,
  type: "image" | "document" | "video",
  link: string,
  caption?: string,
  filename?: string,
): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!phoneNumberId || !token) return

  // Derive MIME type from file extension for the upload step
  const ext = link.split(".").pop()?.toLowerCase().split("?")[0] ?? ""
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif",
    pdf: "application/pdf",
    mp4: "video/mp4", mov: "video/quicktime",
  }
  const mimeType = mimeMap[ext] ?? (
    type === "image" ? "image/jpeg" :
    type === "video" ? "video/mp4" :
    "application/octet-stream"
  )

  try {
    // Step 1: upload to WhatsApp to get a media_id
    const mediaId = await uploadMediaToWhatsApp(phoneNumberId, token, link, mimeType)

    // Step 2: send the message using the media_id
    const mediaPayload: Record<string, unknown> = { id: mediaId }
    if (caption) mediaPayload.caption = caption
    if (type === "document" && filename) mediaPayload.filename = filename

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: baseHeaders(token),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type,
          [type]: mediaPayload,
        }),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      console.error("[WA-SEND] Media send error:", res.status, err)
    }
  } catch (e) {
    console.error("[WA-SEND] Media send failed:", e)
    throw e  // re-throw so caller's .catch() captures it
  }
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
