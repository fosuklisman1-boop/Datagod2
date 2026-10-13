import { createHmac, timingSafeEqual } from "crypto"
import { isBillerKey, type BillerKey } from "./billers"

export const BILL_TOKEN_TTL_MS = 10 * 60_000
const DOMAIN = "bills-verify:"

export interface VerifiedBill {
  userId: string; biller: BillerKey; account: string; phone: string | null; email: string | null
  broadbandAccount: string | null; sessionId: string | null; customerName: string | null; verified: boolean; issuedAt: number
}

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(DOMAIN + body).digest("hex")

export function signBillToken(v: VerifiedBill, secret: string): string {
  if (!secret) throw new Error("bills: token secret not configured")
  const body = Buffer.from(JSON.stringify(v)).toString("base64url")
  return `${body}.${mac(body, secret)}`
}

export function verifyBillToken(token: string, secret: string, userId: string, now: number): VerifiedBill | null {
  if (!secret || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const want = Buffer.from(mac(body, secret))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let v: any
  try { v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { return null }
  if (!v || v.userId !== userId || !isBillerKey(v.biller) || typeof v.issuedAt !== "number") return null
  if (now - v.issuedAt > BILL_TOKEN_TTL_MS || now < v.issuedAt - 60_000) return null
  return v as VerifiedBill
}
