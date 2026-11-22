// Masks buyer details before they leave a public shop order endpoint.
// Anything that is not clearly the expected kind of value comes back as null,
// never as the raw value.

const asText = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text ? text : null
}

/** First name only. Null when the box holds a number, an email or no letters at all. */
export function maskBuyerName(value: unknown): string | null {
  const text = asText(value)
  if (!text || /\d|@/.test(text)) return null
  const first = text.split(/[\s​-‍﻿,._]+/u).find(Boolean)
  return first && /\p{L}/u.test(first) ? first : null
}

/** First character of the mailbox, then ***@domain. Null unless it is one plain address. */
export function maskBuyerEmail(value: unknown): string | null {
  const text = asText(value)
  if (!text) return null
  const match = /^([^\s@,;]+)@([^\s@,;]+\.[^\s@,;]+)$/.exec(text)
  if (!match || !/\p{L}/u.test(match[2])) return null
  return `${match[1][0]}***@${match[2]}`
}

/** Last three digits only. Null unless it reads as a phone number of 9 to 15 digits. */
export function maskBuyerPhone(value: unknown): string | null {
  const text = asText(value)
  if (!text || !/^[\d\s+()\-]+$/.test(text)) return null
  const digits = text.replace(/\D/g, "")
  if (digits.length < 9 || digits.length > 15) return null
  return `*******${digits.slice(-3)}`
}
