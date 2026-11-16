import { describe, it, expect } from "vitest"
import crypto from "node:crypto"
import { sm4EncryptBlock, sm4DecryptBlock, sm4CbcEncrypt, sm4CbcDecrypt } from "./sm4-block"

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")
const nativeOk = crypto.getCiphers().includes("sm4-cbc")

describe("sm4 block", () => {
  it("matches the official GB/T 32907 vector", () => {
    const k = Buffer.from("0123456789abcdeffedcba9876543210", "hex")
    expect(hex(sm4EncryptBlock(k, k))).toBe("681edf34d206965e86b3e94f536e4246")
    expect(hex(sm4DecryptBlock(k, Buffer.from("681edf34d206965e86b3e94f536e4246", "hex")))).toBe("0123456789abcdeffedcba9876543210")
  })

  it("matches the official 1,000,000-iteration vector", () => {
    const k = Buffer.from("0123456789abcdeffedcba9876543210", "hex")
    let b: Uint8Array = k
    for (let i = 0; i < 1_000_000; i++) b = sm4EncryptBlock(k, b)
    expect(hex(b)).toBe("595298c7c6fd271f0402f804c33d3f66")
  }, 120_000)
})

describe("sm4 cbc", () => {
  it.skipIf(!nativeOk)("equals Node's native sm4-cbc and round-trips, for assorted lengths", () => {
    for (const len of [0, 1, 15, 16, 17, 100, 500]) {
      const key = crypto.randomBytes(16)
      const iv = crypto.randomBytes(16)
      const plain = crypto.randomBytes(len)
      const c = crypto.createCipheriv("sm4-cbc", key, iv)
      const native = Buffer.concat([c.update(plain), c.final()])
      const mine = sm4CbcEncrypt(key, iv, plain)
      expect(mine.toString("hex")).toBe(native.toString("hex"))
      expect(sm4CbcDecrypt(key, iv, mine)?.toString("hex")).toBe(plain.toString("hex"))
    }
  })

  it("round-trips without native support", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex")
    const iv = Buffer.from("03050609060905090305060906090509", "hex")
    for (const len of [0, 1, 15, 16, 17, 100]) {
      const plain = Buffer.alloc(len, 0x61)
      const enc = sm4CbcEncrypt(key, iv, plain)
      expect(enc.length % 16).toBe(0)
      expect(enc.length).toBeGreaterThan(len)
      expect(sm4CbcDecrypt(key, iv, enc)?.equals(plain)).toBe(true)
    }
  })

  it("returns null for a wrong length, empty input or bad padding, and never throws", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex")
    const iv = Buffer.alloc(16, 1)
    expect(sm4CbcDecrypt(key, iv, Buffer.alloc(0))).toBeNull()
    expect(sm4CbcDecrypt(key, iv, Buffer.alloc(15))).toBeNull()
    expect(sm4CbcDecrypt(key, iv, Buffer.alloc(17))).toBeNull()
    expect(sm4CbcDecrypt(key, iv, Buffer.alloc(16, 7))).toBeNull()
    expect(sm4CbcDecrypt(Buffer.alloc(3), iv, Buffer.alloc(16))).toBeNull()
  })
})
