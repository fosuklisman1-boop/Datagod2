// lib/whatsapp-bot/send.ts
const GRAPH_API_VERSION = "v25.0"

function baseHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
}

// The AI emits Markdown, but WhatsApp uses *single* asterisks for bold (and has
// no headings or [text](url) links), so Markdown leaks as literal `**`, `###`,
// etc. Convert AI output to WhatsApp formatting before sending.
export function formatForWhatsApp(text: string): string {
  if (!text) return text
  return text
    // **bold** / __bold__  →  *bold*  (WhatsApp bold). Non-greedy, single line.
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    // "### Heading"  →  *Heading*
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, "*$1*")
    // [label](url)  →  label (url)   (WhatsApp doesn't render markdown links)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
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
  console.log("[WA-SEND] Fetching media from storage:", fileUrl)
  let fileRes: Response
  try {
    fileRes = await fetch(fileUrl)
  } catch (e) {
    throw new Error(`Failed to fetch media from storage URL (network error): ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!fileRes.ok) throw new Error(`Failed to fetch media from storage (${fileRes.status} ${fileRes.statusText}) for ${fileUrl}`)
  const fileBuffer = await fileRes.arrayBuffer()
  console.log("[WA-SEND] Fetched media:", fileBuffer.byteLength, "bytes, mimeType:", mimeType)

  // Upload to WhatsApp media API as multipart/form-data
  const formData = new FormData()
  formData.append("messaging_product", "whatsapp")
  formData.append("type", mimeType)
  const ext = fileUrl.split(".").pop()?.split("?")[0] ?? "bin"
  formData.append("file", new Blob([fileBuffer], { type: mimeType }), `upload.${ext}`)

  console.log("[WA-SEND] Uploading media to WhatsApp, phoneNumberId:", phoneNumberId)
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
  console.log("[WA-SEND] Got media_id:", id)
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
  if (!phoneNumberId || !token) {
    throw new Error("WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set")
  }

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

  console.log("[WA-SEND] sendWhatsAppMedia: to=%s type=%s link=%s", to, type, link)

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
      throw new Error(`WhatsApp media send failed (${res.status}): ${err}`)
    }
    console.log("[WA-SEND] Media message sent successfully to", to)
  } catch (e) {
    console.error("[WA-SEND] Media send failed:", e)
    throw e  // re-throw so caller's .catch() captures it
  }
}

// Inverse of uploadMediaToWhatsApp: resolve a media id to its bytes via the
// 2-step Graph API flow (GET /{media-id} -> {url, mime_type}, then GET {url}).
export async function downloadWaMedia(mediaId: string): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN not set")

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!metaRes.ok) throw new Error(`Failed to get media metadata (${metaRes.status})`)
  const { url, mime_type } = await metaRes.json() as { url: string; mime_type: string }

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!fileRes.ok) throw new Error(`Failed to download media (${fileRes.status})`)

  return { buffer: await fileRes.arrayBuffer(), mimeType: mime_type }
}

export interface WaTemplateComponent {
  type: "header" | "body" | "button"
  parameters: Array<
    | { type: "text"; text: string }
    | { type: "document"; document: { link: string; filename?: string } }
    | { type: "image"; image: { link: string } }
  >
}

// Sends a pre-approved template message — the only way to reach a customer
// outside the 24h customer-service window (free-form sendWhatsAppText/Media
// fail with error 131047 once that window closes). The template name,
// language code and component shape must match what's approved in Meta
// Business Manager. Returns false on failure rather than throwing, matching
// sendWhatsAppText.
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components?: WaTemplateComponent[],
): Promise<boolean> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN

  if (!phoneNumberId || !token) {
    console.error("[WA-SEND] WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set")
    return false
  }

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: baseHeaders(token),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          ...(components && components.length > 0 ? { components } : {}),
        },
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error("[WA-SEND] Template send error:", res.status, err)
      return false
    }
    return true
  } catch (e) {
    console.error("[WA-SEND] Template fetch error:", e)
    return false
  }
}

// Returns the sent message's WhatsApp id (wamid) on success, or null on failure.
// The wamid is what status webhooks (delivered/read) reference, so callers that
// log the message can store it to drive delivery ticks. Never throws. The
// non-null return is still truthy, so callers doing `if (ok)` / `if (!ok)` keep
// working unchanged. On a 200 with no id (not expected from Meta) it returns a
// truthy "sent" sentinel so success isn't misread as failure.
export async function sendWhatsAppText(to: string, body: string): Promise<string | null> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN

  if (!phoneNumberId || !token) {
    console.error("[WA-SEND] WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set")
    return null
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
      return null
    }
    const json = await res.json().catch(() => null) as { messages?: Array<{ id?: string }> } | null
    return json?.messages?.[0]?.id ?? "sent"
  } catch (e) {
    console.error("[WA-SEND] fetch error:", e)
    return null
  }
}
