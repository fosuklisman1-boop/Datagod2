// lib/ai-vision.ts
//
// One-shot image understanding for the WhatsApp bot. A customer's inbound image
// is turned into a SHORT TEXT description here, which is then fed into the normal
// text-only agentic loop (see app/api/whatsapp/webhook/route.ts). This keeps the
// multi-provider loop unchanged — its history converters intentionally strip image
// blocks, so vision lives outside it as a dedicated pre-pass.
//
// SECURITY: the description is UNVERIFIED. A screenshot of a "successful payment"
// is trivially faked. The webhook injects this text labelled UNVERIFIED and the
// system prompt forbids ever treating it as proof of payment — the only money path
// remains Paystack verification (reverify_payment / webhook).

import {
  resolveProviderForContext,
  getProvider,
  DEFAULT_CONFIG,
  type AIProviderConfig,
  type ProviderName,
} from "@/lib/ai-providers"

// WhatsApp caps inbound images at ~5 MB; this is headroom plus an OOM guard so a
// huge file can never blow up the process when we base64-encode it for the model.
const MAX_VISION_BYTES = 8 * 1024 * 1024

const VISION_PROMPT = [
  "You describe images for a Ghanaian data-bundle support bot so a text-only assistant can help the customer.",
  "Describe the image in 1-2 short sentences.",
  "If it is a payment receipt, MoMo confirmation, bank/transfer screenshot, or any payment proof, also extract what you can read: amount, status text, transaction/reference ID, sender and recipient phone numbers, and date.",
  "State plainly that anything in the image is UNVERIFIED and must not be treated as proof of payment.",
  "Be concise and factual. Do not add advice or greetings.",
].join(" ")

// Which configured provider+model can actually accept an image. The default
// WhatsApp models for Anthropic/OpenAI/Gemini are all vision-capable. DeepSeek's
// hosted chat models (deepseek-chat / deepseek-reasoner) and Groq's listed
// Llama/Gemma text models are NOT — their vision lives in separate models
// (deepseek-vl*, llama-*-vision / llama-4-scout|maverick). Rather than hardcode a
// brittle allowlist, we whitelist the families we know see and pattern-match the
// rest; anything uncertain falls back to the Anthropic describer below.
function modelSupportsVision(provider: ProviderName, model: string): boolean {
  const m = (model || "").toLowerCase()
  switch (provider) {
    case "anthropic": return true // claude 3+ (haiku/sonnet/opus) all read images
    case "openai":    return true // gpt-4o family + gpt-4.1 all read images
    case "gemini":    return true // gemini 1.5/2.x all read images
    case "deepseek":  return /vl|vision/.test(m)
    case "groq":      return /vision|scout|maverick|llama-4/.test(m)
    default:          return false
  }
}

function toBase64(bytes: ArrayBuffer | Uint8Array | Buffer): string {
  return Buffer.from(bytes as Uint8Array).toString("base64")
}

/**
 * Describe an inbound image as plain text.
 *
 * Strategy:
 *  1. Use the configured WhatsApp provider IF its model is vision-capable (so an
 *     admin who sets the bot to OpenAI/Gemini — or a DeepSeek/Groq vision model —
 *     gets vision on that provider).
 *  2. Otherwise (or on any error), fall back to Anthropic Haiku, which is always
 *     vision-capable and available via ANTHROPIC_API_KEY. This guarantees image
 *     reading works regardless of which provider runs the conversation.
 *
 * Returns "" on total failure so the caller can still proceed text-only.
 */
export async function describeImage(
  bytes: ArrayBuffer | Uint8Array | Buffer,
  mimeType: string,
  caption: string,
  config: AIProviderConfig,
): Promise<string> {
  // Size guard FIRST — never base64-encode an oversized buffer (OOM/DoS). Degrade to
  // text-only (caller asks the customer to describe the image) rather than crash.
  const byteLength = (bytes as { byteLength?: number }).byteLength ?? 0
  if (!byteLength || byteLength > MAX_VISION_BYTES) {
    if (byteLength > MAX_VISION_BYTES) console.warn("[ai-vision] image too large for vision, skipping:", byteLength)
    return ""
  }

  const cleanMime = (mimeType || "image/jpeg").split(";")[0].trim().toLowerCase()
  const base64 = toBase64(bytes)
  const prompt = caption
    ? `${VISION_PROMPT}\n\nThe customer's caption: "${caption.slice(0, 300)}"`
    : VISION_PROMPT

  let configuredWasAnthropic = false
  try {
    const { provider, model, providerName } = resolveProviderForContext("whatsapp", config)
    configuredWasAnthropic = providerName === "anthropic"
    if (modelSupportsVision(providerName, model)) {
      const out = await provider.describeImage({ model, base64, mediaType: cleanMime, prompt })
      if (out && out.trim()) return out.trim()
    }
  } catch (err) {
    // Configured provider couldn't see (bad key, unsupported model, transient).
    // Don't reset configuredWasAnthropic — if the configured provider already WAS
    // Anthropic, the fallback would just be an identical (same key) retry, so skip it.
    console.error("[ai-vision] configured provider vision failed:", err instanceof Error ? err.message : String(err))
  }

  // Fallback: Anthropic (always vision-capable, present as the platform default) so
  // image-reading works even when the conversation provider is text-only (e.g.
  // deepseek-chat). Skipped when Anthropic was already the configured provider.
  const anthropicKey = config.anthropic_api_key || process.env.ANTHROPIC_API_KEY || ""
  if (!configuredWasAnthropic && anthropicKey) {
    console.log("[ai-vision] configured provider is not vision-capable — using Anthropic vision fallback")
    try {
      const out = await getProvider("anthropic", anthropicKey)
        .describeImage({ model: DEFAULT_CONFIG.whatsapp_model, base64, mediaType: cleanMime, prompt })
      if (out && out.trim()) return out.trim()
    } catch (err) {
      console.error("[ai-vision] anthropic fallback vision failed:", err instanceof Error ? err.message : String(err))
    }
  }

  return ""
}
