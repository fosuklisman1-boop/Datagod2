import { createHmac, timingSafeEqual } from "crypto"
import { BUNDLE_NETWORKS, type BundleNetwork } from "./categories"
import { SPECIAL_MAX_MULTIPLE } from "./config"

export const BUNDLE_TOKEN_TTL_MS = 10 * 60_000
const DOMAIN = "bundles-catalog:"
// Distinct MAC domain = the type tag: a normal token can never verify as special and vice versa.
const SPECIAL_DOMAIN = "bundles-special:"
const SPECIAL_TYPE = "special"

/** Not user-bound: it only proves the (value, amount) pair came from our catalog. */
export interface VerifiedBundle {
  network: BundleNetwork
  value: string
  amount: number
  display: string
  category: string
  issuedAt: number
}

/** A Special plan: N × the unit bundle. `unitToken` is an ordinary bundle token for the unit. */
export interface SpecialTokenInput { unitToken: string; n: number; issuedAt: number }
export interface VerifiedSpecial { unit: VerifiedBundle; n: number; issuedAt: number }

const macWith = (domain: string, body: string, secret: string) =>
  createHmac("sha256", secret).update(domain + body).digest("hex")
const mac = (body: string, secret: string) => macWith(DOMAIN, body, secret)

const fresh = (issuedAt: number, now: number) => !(now - issuedAt > BUNDLE_TOKEN_TTL_MS || now < issuedAt - 60_000)

/** Checks the MAC under `domain` and returns the parsed JSON body, or null. */
function openToken(domain: string, token: string, secret: string): any {
  if (!secret || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const want = Buffer.from(macWith(domain, body, secret))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let v: any
  try { v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { return null }
  return v && typeof v === "object" ? v : null
}

export function signBundleToken(v: VerifiedBundle, secret: string): string {
  if (!secret) throw new Error("bundles: token secret not configured")
  const body = Buffer.from(JSON.stringify(v)).toString("base64url")
  return `${body}.${mac(body, secret)}`
}

export function verifyBundleToken(token: string, secret: string, now: number): VerifiedBundle | null {
  const v = openToken(DOMAIN, token, secret)
  if (!v) return null
  if (!BUNDLE_NETWORKS.includes(v.network)) return null
  if (typeof v.value !== "string" || v.value === "" || typeof v.display !== "string" || typeof v.category !== "string") return null
  if (typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount <= 0) return null
  if (typeof v.issuedAt !== "number") return null
  if (!fresh(v.issuedAt, now)) return null
  return v as VerifiedBundle
}

export function signSpecialToken(p: SpecialTokenInput, secret: string): string {
  if (!secret) throw new Error("bundles: token secret not configured")
  const body = Buffer.from(JSON.stringify({ type: SPECIAL_TYPE, unitToken: p.unitToken, n: p.n, issuedAt: p.issuedAt })).toString("base64url")
  return `${body}.${macWith(SPECIAL_DOMAIN, body, secret)}`
}

/**
 * Route branch only: the token carries a valid special MAC and type tag, fresh or not. It picks buySpecial (which
 * still runs verifySpecialToken in full) so an expired special token can still reach its replay lookup. A normal
 * bundle token never passes: it is signed under a different MAC domain.
 */
export function isSpecialTokenSigned(token: string, secret: string): boolean {
  const v = openToken(SPECIAL_DOMAIN, token, secret)
  return !!v && v.type === SPECIAL_TYPE
}

/** MTN only. The embedded unit token must verify on its own, with the same issuedAt. */
export function verifySpecialToken(token: string, secret: string, now: number): VerifiedSpecial | null {
  const v = openToken(SPECIAL_DOMAIN, token, secret)
  if (!v || v.type !== SPECIAL_TYPE) return null
  if (typeof v.n !== "number" || !Number.isInteger(v.n) || v.n < 1 || v.n > SPECIAL_MAX_MULTIPLE) return null
  if (typeof v.issuedAt !== "number" || !fresh(v.issuedAt, now)) return null
  if (typeof v.unitToken !== "string") return null
  const unit = verifyBundleToken(v.unitToken, secret, now)
  if (!unit || unit.network !== "MTN" || unit.issuedAt !== v.issuedAt) return null
  return { unit, n: v.n, issuedAt: v.issuedAt }
}
