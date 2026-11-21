// "First Last · masked contact" for the target-user line on admin cards. Contact details are masked so the card is
// checkable without exposing a full phone or email. Never logged.

export interface UserLabelRow {
  first_name?: string | null
  last_name?: string | null
  phone_number?: string | null
  email?: string | null
}

/** 024 *** 4567: first 3 and last 4 characters. */
export function maskPhone(local: string): string {
  return `${local.slice(0, 3)} *** ${local.slice(-4)}`
}

/** a***@example.com */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@")
  if (at < 1) return "***"
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

export function userLabel(userId: string, row: UserLabelRow | null | undefined): string {
  const name = [row?.first_name, row?.last_name].map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean).join(" ")
  const phone = typeof row?.phone_number === "string" && row.phone_number.trim() ? maskPhone(row.phone_number.trim()) : ""
  const email = typeof row?.email === "string" && row.email.includes("@") ? maskEmail(row.email.trim()) : ""
  const contact = phone || email
  if (name && contact) return `${name} · ${contact}`
  return name || contact || userId.slice(0, 8)
}
