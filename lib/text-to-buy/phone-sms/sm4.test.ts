import { describe, it, expect } from "vitest"
import crypto from "node:crypto"
import { buildSendBody, decodeResponse, parseKey } from "./sm4"
import { sm4CbcDecrypt, sm4CbcEncrypt } from "./sm4-block"

const IV = Buffer.from([3, 5, 6, 9, 6, 9, 5, 9, 3, 5, 6, 9, 6, 9, 5, 9])
const KEY_HEX = "00112233445566778899aabbccddeeff"
const KEY = Buffer.from(KEY_HEX, "hex")

// Independent check against Node's native SM4 when the host has it; the pure implementation stands in where OpenSSL lacks SM4.
const native = crypto.getCiphers().includes("sm4-cbc")

function enc(obj: unknown, key = KEY): string {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj)
  if (!native) return sm4CbcEncrypt(key, IV, Buffer.from(text, "utf8")).toString("hex")
  const c = crypto.createCipheriv("sm4-cbc", key, IV)
  return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("hex")
}

function dec(key: Buffer, hex: string): string {
  if (!native) return sm4CbcDecrypt(key, IV, Buffer.from(hex, "hex"))!.toString("utf8")
  const d = crypto.createDecipheriv("sm4-cbc", key, IV)
  return Buffer.concat([d.update(Buffer.from(hex, "hex")), d.final()]).toString("utf8")
}

describe("parseKey", () => {
  it("accepts exactly 32 hex chars", () => {
    expect(parseKey(KEY_HEX)?.equals(KEY)).toBe(true)
    expect(parseKey(KEY_HEX.toUpperCase())?.equals(KEY)).toBe(true)
  })
  it("rejects 31/33 chars, non-hex and non-strings", () => {
    expect(parseKey(KEY_HEX.slice(1))).toBeNull()
    expect(parseKey(KEY_HEX + "0")).toBeNull()
    expect(parseKey("zz" + KEY_HEX.slice(2))).toBeNull()
    expect(parseKey("")).toBeNull()
    expect(parseKey(undefined as unknown as string)).toBeNull()
  })
})

describe("buildSendBody", () => {
  it("is lowercase hex and decrypts to the signed envelope", () => {
    const body = buildSendBody(KEY, KEY_HEX, { simSlot: 2, to: "0200000901", text: "hello there", nowMs: 1700000000123 })
    expect(body).toMatch(/^[0-9a-f]+$/)
    const plain = dec(KEY, body)
    const env = JSON.parse(plain)
    expect(env.data).toEqual({ sim_slot: 2, phone_numbers: "0200000901", msg_content: "hello there" })
    expect(Number.isInteger(env.timestamp)).toBe(true)
    expect(env.timestamp).toBe(1700000000123)
    const sig = crypto.createHmac("sha256", KEY).update(`${env.timestamp}\n${KEY_HEX}`).digest("base64")
    expect(env.sign).toBe(encodeURIComponent(sig))
  })
})

describe("decodeResponse", () => {
  it("returns the code and msg for a valid encrypted reply", () => {
    const body = enc({ code: 200, msg: "success", data: "success", timestamp: 1 })
    expect(decodeResponse(KEY, body)).toEqual({ code: 200, msg: "success" })
    expect(decodeResponse(KEY, enc({ code: 500, msg: "bad", data: null, timestamp: 1 }))?.code).toBe(500)
  })
  it("returns null for non-hex, wrong length, bad padding and non-JSON", () => {
    expect(decodeResponse(KEY, "not hex at all")).toBeNull()
    expect(decodeResponse(KEY, "")).toBeNull()
    expect(decodeResponse(KEY, "abcd")).toBeNull()
    expect(decodeResponse(KEY, "00".repeat(16))).toBeNull()
    expect(decodeResponse(KEY, enc("this is not json"))).toBeNull()
    expect(decodeResponse(KEY, enc({ msg: "no code" }))).toBeNull()
    expect(decodeResponse(Buffer.from("ffeeddccbbaa99887766554433221100", "hex"), enc({ code: 200 }))).toBeNull()
  })
})
