import crypto from "crypto"
import { hashApiKey } from "@/lib/api-auth"

export type KeyType = "standard" | "commission" | "sms"
export type Environment = "test" | "live"
export type KeyStatus = "pending" | "active" | "revoked"

// v2 keys use "dg2_" so they can never be confused with v1 "dg_live_" keys.
const TYPE_SEGMENT: Record<KeyType, string> = {
  standard: "",
  commission: "cs_",
  sms: "sms_",
}

const KEY_PATTERN = /^dg2_(?:(cs|sms)_)?(test|live)_([0-9a-f]+)$/

export function hashV2Key(key: string): string {
  return hashApiKey(key)
}

export function generateV2Key(
  type: KeyType,
  env: Environment
): { key: string; prefix: string; hash: string } {
  const body = crypto.randomBytes(32).toString("hex")
  const key = `dg2_${TYPE_SEGMENT[type]}${env}_${body}`
  return { key, prefix: key.slice(0, 16), hash: hashV2Key(key) }
}

export function parseV2Key(raw: string): { type: KeyType; env: Environment } | null {
  const m = KEY_PATTERN.exec(raw)
  if (!m) return null
  const type: KeyType = m[1] === "cs" ? "commission" : m[1] === "sms" ? "sms" : "standard"
  return { type, env: m[2] as Environment }
}
