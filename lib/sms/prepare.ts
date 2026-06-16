export interface ShopTokens {
  shop_name: string
  shop_link: string
  shop_phone: string
  shop_whatsapp: string
}

/**
 * Remove characters that prevent SMS delivery on standard providers:
 * - Astral (supplementary) Unicode code points (emoji, mathematical symbols, etc.)
 * - Zero-width joiners / variation selectors
 * Trims leading/trailing whitespace only when the message actually changed.
 */
export function stripUndeliverableChars(message: string): string {
  const stripped = message
    // Variation selectors (U+FE00–FE0F)
    .replace(/[︀-️]/g, "")
    // Zero-width joiner / non-joiner / non-breaking-space-like (U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF, U+00AD)
    .replace(/[​-‏‪-‮⁠-⁤﻿­]/g, "")
    // Astral code points (emoji, mathematical alphanumerics, etc.) — use Unicode property escape
    .replace(/\p{So}|\p{Cs}/gu, "")
    // Remaining astral range via surrogate pairs (belt-and-suspenders for older runtimes)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")

  if (stripped === message) return message
  return stripped.trim()
}

/**
 * Replace {shop_name}, {shop_link}, {shop_phone}, {shop_whatsapp} tokens,
 * then strip undeliverable characters. Throws if the result is empty.
 * Bill the PREPARED text (what the provider actually sends).
 */
export function prepareSmsMessage(message: string, tokens: ShopTokens): string {
  let result = message
  result = result.replace(/\{shop_name\}/g, tokens.shop_name)
  result = result.replace(/\{shop_link\}/g, tokens.shop_link)
  result = result.replace(/\{shop_phone\}/g, tokens.shop_phone)
  result = result.replace(/\{shop_whatsapp\}/g, tokens.shop_whatsapp)
  result = stripUndeliverableChars(result)
  if (result.trim().length === 0) {
    throw new Error("SMS message is empty after stripping undeliverable characters")
  }
  return result
}
