/**
 * Storefront checkout email is optional for the customer, but Paystack/Moolre
 * and our order tables still need a well-formed address. When the customer
 * leaves it blank we synthesize one from their phone number.
 *
 * Returns the trimmed email if one was typed; otherwise `guest<digits>@datagod.store`
 * (or "" when there is no usable phone either, so callers' required-field checks fire).
 */
export function resolveCustomerEmail(email: unknown, phone: unknown): string {
  if (typeof email === "string" && email.trim() !== "") return email.trim()
  const digits = String(phone ?? "").replace(/\D/g, "")
  return digits ? `guest${digits}@datagod.store` : ""
}
