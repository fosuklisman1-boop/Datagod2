import { ghanaSignificant } from "@/lib/phone-format"

export interface HandoffMessage {
  role: string
  content: string
}

export interface HandoffContact {
  phone: string
  whatsapp: string
}

const MAX_MESSAGES = 5
const MAX_CHARS = 2000

/** Removes card-result wrappers and "[card …" notes (the same shapes lib/ai-drafts/outcome-notes.ts treats as forged). */
function clean(text: string): string {
  return text
    .replace(/<\s*card_results\b[^>]*>[\s\S]*?<\s*\/\s*card_results\s*>/gi, " ")
    .replace(/<\s*\/?\s*card_results\b[^>\n]*>?/gi, " ")
    .replace(/\[\s*card\b[^\n]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Last ≤5 user/assistant messages as "Me:"/"AI:" lines, ≤2,000 chars, cut at a line boundary. */
export function buildHandoffMessage(messages: HandoffMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue
    const text = clean(typeof m.content === "string" ? m.content : "")
    if (!text) continue
    lines.push(`${m.role === "user" ? "Me" : "AI"}: ${text}`)
  }
  const out: string[] = []
  let used = 0
  for (const line of lines.slice(-MAX_MESSAGES)) {
    const cost = line.length + (out.length ? 1 : 0)
    if (used + cost > MAX_CHARS) break
    out.push(line)
    used += cost
  }
  return out.join("\n")
}

/** Exact body for POST /api/support/threads (createThreadSchema). Customer text may not contain < > &. */
export function buildHandoffThreadBody(messages: HandoffMessage[], contact: HandoffContact) {
  const raw = buildHandoffMessage(messages)
  const transcript = raw.replace(/[<>&]/g, " ")
  const DEFAULT_MESSAGE = "Me: I would like to speak to a person."
  const message = transcript.length >= 5 && !hasScript(raw) && !hasScript(transcript) ? transcript : DEFAULT_MESSAGE
  return {
    subject: "From AI chat",
    category: "other" as const,
    message,
    phone_number: contact.phone,
    whatsapp_number: contact.whatsapp,
  }
}

// Same script-injection patterns the support schema rejects (lib/support-validation.ts), so a transcript that would fail is replaced.
const SCRIPT_PATTERNS = [/javascript:/i, /<script/i, /\bon(?!(?:ly|ce|e|es|line|to|going)\b)\w+\s*=/i]
const hasScript = (s: string) => SCRIPT_PATTERNS.some((re) => re.test(s))

/** Canonical local 0XXXXXXXXX for any accepted Ghana format (spaces, 233, +233, 00233), or null. */
export function normaliseHandoffPhone(phone?: string | null): string | null {
  if (!phone) return null
  const sig = ghanaSignificant(phone.trim().replace(/^\+?00(?=233)/, ""))
  return sig ? `0${sig}` : null
}

export function handoffFailureMessage(status?: number, hasWhatsApp = true): string {
  const head = status === 409 ? "You already have 3 open support chats" : "Couldn't open a support chat"
  return hasWhatsApp ? `${head} — opening WhatsApp instead.` : `${head}. Please try again later.`
}

/** False when pressing the button could do nothing at all (so the UI hides it). */
export function handoffAvailable(o: { mode: "thread" | "whatsapp"; hasToken?: boolean; phone?: string | null; whatsapp?: string | null }): boolean {
  const wa = !!whatsappHref(o.whatsapp)
  if (o.mode === "whatsapp") return wa
  return (!!o.hasToken && !!normaliseHandoffPhone(o.phone)) || wa
}

const WA_HOSTS = new Set(["wa.me", "api.whatsapp.com", "chat.whatsapp.com", "wa.link"])

/** A safe WhatsApp URL: an https link on a WhatsApp host, or a phone number. Anything else is null. */
export function whatsappHref(value?: string | null): string | null {
  const v = value?.trim()
  if (!v) return null
  if (/^https:\/\//i.test(v)) {
    try {
      const u = new URL(v)
      return u.protocol === "https:" && !u.username && !u.password && WA_HOSTS.has(u.hostname.toLowerCase()) ? v : null
    } catch {
      return null
    }
  }
  if (!/^\+?[\d\s-]+$/.test(v)) return null
  const digits = v.replace(/\D/g, "")
  if (digits.length < 9) return null
  return `https://wa.me/${digits.startsWith("0") ? `233${digits.slice(1)}` : digits}`
}
