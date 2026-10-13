import { createHmac, timingSafeEqual } from "crypto"
import { BUNDLE_NETWORKS, type BundleNetwork } from "./categories"

export const BUNDLE_TOKEN_TTL_MS = 10 * 60_000
const DOMAIN = "bundles-catalog:"

/** Not user-bound: it only proves the (value, amount) pair came from our catalog. */
export interface VerifiedBundle {
  network: BundleNetwork
  value: string
  amount: number
  display: string
  category: string
  issuedAt: number
}

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(DOMAIN + body).digest("hex")

export function signBundleToken(v: VerifiedBundle, secret: string): string {
  if (!secret) throw new Error("bundles: token secret not configured")
  const body = Buffer.from(JSON.stringify(v)).toString("base64url")
  return `${body}.${mac(body, secret)}`
}

export function verifyBundleToken(token: string, secret: string, now: number): VerifiedBundle | null {
  if (!secret || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const want = Buffer.from(mac(body, secret))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let v: any
  try { v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { return null }
  if (!v || typeof v !== "object") return null
  if (!BUNDLE_NETWORKS.includes(v.network)) return null
  if (typeof v.value !== "string" || v.value === "" || typeof v.display !== "string" || typeof v.category !== "string") return null
  if (typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount <= 0) return null
  if (typeof v.issuedAt !== "number") return null
  if (now - v.issuedAt > BUNDLE_TOKEN_TTL_MS || now < v.issuedAt - 60_000) return null
  return v as VerifiedBundle
}
