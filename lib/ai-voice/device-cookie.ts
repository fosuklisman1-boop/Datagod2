import { randomBytes } from "node:crypto"
import type { NextRequest, NextResponse } from "next/server"
import { endUserIdFor } from "./gate"

export const DEVICE_COOKIE = "dg_vdid"
const VALID = /^[a-f0-9]{32}$/

/** The caller's device id from the cookie, or null when absent or malformed. */
export function readDeviceId(req: NextRequest): string | null {
  const v = req.cookies.get(DEVICE_COOKIE)?.value
  return v && VALID.test(v) ? v : null
}

export function newDeviceId(): string {
  return randomBytes(16).toString("hex")
}

export function setDeviceCookie(res: NextResponse, id: string): void {
  res.cookies.set(DEVICE_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })
}

/** Returns the device id, minting one and setting the cookie on `res` when the request had none. */
export function getOrSetDeviceId(req: NextRequest, res: NextResponse): string {
  const existing = readDeviceId(req)
  if (existing) return existing
  const id = newDeviceId()
  setDeviceCookie(res, id)
  return id
}

export const voiceSalt = () => process.env.NUANCE_DEVICE_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || ""

/** The stored device_hash: the 32-hex digest of endUserIdFor (without the d_ prefix). */
export function deviceHashFor(deviceId: string): string {
  return endUserIdFor(null, deviceId, voiceSalt()).slice(2)
}
