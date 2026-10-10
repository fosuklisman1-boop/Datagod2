/** Pure KYC rules (spec §5.6). The Ghana Card number is validated but only its last 4
 *  digits are stored; the uploaded card photo is the verification artifact. */
export const GHANA_CARD_RE = /^GHA-\d{9}-\d$/
export const KYC_DOC_MAX_BYTES = 4 * 1024 * 1024 // Vercel rejects request bodies over ~4.5 MB (the bucket itself allows 5 MB)
const DOC_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }

export type KycStatus = "draft" | "submitted" | "approved" | "rejected"
export type KycAction = "save" | "submit" | "approve" | "reject"

export interface KycDraftInput {
  business_name?: string; description?: string; website?: string; whatsapp_number?: string; ghana_card_number?: string
}
export interface KycDraftPatch {
  business_name?: string; description?: string; website?: string | null; whatsapp_number?: string; ghana_card_last4?: string
}

function normalizeGhanaPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "")
  if (/^233\d{9}$/.test(d)) return d
  if (/^0\d{9}$/.test(d)) return `233${d.slice(1)}`
  if (/^\d{9}$/.test(d)) return `233${d}`
  return null
}

function normalizeWebsite(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    return /\.[a-z]{2,}$/i.test(u.hostname) ? withScheme : null
  } catch {
    return null
  }
}

export function validateKycDraft(input: KycDraftInput): { ok: true; patch: KycDraftPatch } | { ok: false; errors: Record<string, string> } {
  const patch: KycDraftPatch = {}
  const errors: Record<string, string> = {}
  if (input.business_name !== undefined) {
    const v = input.business_name.trim()
    if (v.length < 2 || v.length > 120) errors.business_name = "Business name must be 2–120 characters."
    else patch.business_name = v
  }
  if (input.description !== undefined) {
    const v = input.description.trim()
    if (v.length < 10 || v.length > 2000) errors.description = "Description must be 10–2000 characters."
    else patch.description = v
  }
  if (input.website !== undefined) {
    if (!input.website.trim()) patch.website = null
    else {
      const w = normalizeWebsite(input.website)
      if (!w) errors.website = "Enter a valid website, e.g. kingsdata.com."
      else patch.website = w
    }
  }
  if (input.whatsapp_number !== undefined) {
    const p = normalizeGhanaPhone(input.whatsapp_number)
    if (!p) errors.whatsapp_number = "Enter a Ghana WhatsApp number, e.g. 024 123 4567."
    else patch.whatsapp_number = p
  }
  if (input.ghana_card_number !== undefined) {
    const card = input.ghana_card_number.trim().toUpperCase()
    if (!GHANA_CARD_RE.test(card)) errors.ghana_card_number = "Ghana Card number must look like GHA-123456789-0."
    else patch.ghana_card_last4 = card.replace(/\D/g, "").slice(-4)
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, patch }
}

const REQUIRED_FOR_SUBMIT = ["business_name", "description", "whatsapp_number", "ghana_card_last4", "ghana_card_doc_path"] as const
export function missingForSubmit(row: Partial<Record<(typeof REQUIRED_FOR_SUBMIT)[number], string | null>>): string[] {
  return REQUIRED_FOR_SUBMIT.filter((k) => !row[k])
}

export function nextKycStatus(current: KycStatus | null, action: KycAction): KycStatus | null {
  switch (action) {
    case "save": return current === null || current === "draft" || current === "rejected" ? "draft" : null
    case "submit": return current === "draft" ? "submitted" : null
    case "approve": return current === "submitted" ? "approved" : null
    case "reject": return current === "submitted" ? "rejected" : null
  }
}

export function docExtension(mime: string, size: number): { ok: true; ext: string } | { ok: false; error: string } {
  const ext = DOC_TYPES[mime]
  if (!ext) return { ok: false, error: "Upload a JPG, PNG, WEBP or PDF." }
  if (size <= 0) return { ok: false, error: "The file is empty." }
  if (size > KYC_DOC_MAX_BYTES) return { ok: false, error: "Files must be 4 MB or smaller." }
  return { ok: true, ext }
}

/** The declared MIME is client-supplied; confirm the leading bytes really are that format. */
export function matchesDocSignature(mime: string, bytes: Uint8Array): boolean {
  const at = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  switch (mime) {
    case "image/jpeg": return at(0xff, 0xd8, 0xff)
    case "image/png": return at(0x89, 0x50, 0x4e, 0x47)
    case "application/pdf": return at(0x25, 0x50, 0x44, 0x46)
    case "image/webp": return at(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    default: return false
  }
}
