import { describe, it, expect } from "vitest"
import { readPhoneLink } from "./config"

const KEY = "00112233445566778899aabbccddeeff"

describe("readPhoneLink", () => {
  it("returns the trimmed url and key when both are valid", () => {
    expect(readPhoneLink({ SMS_PHONE_URL: " https://relay.example.test:7003 ", SMS_PHONE_SM4_KEY: ` ${KEY} ` })).toEqual({
      url: "https://relay.example.test:7003",
      keyHex: KEY,
    })
  })
  it("returns null for a missing, malformed or non-http value", () => {
    expect(readPhoneLink({})).toBeNull()
    expect(readPhoneLink({ SMS_PHONE_URL: "https://relay.example.test" })).toBeNull()
    expect(readPhoneLink({ SMS_PHONE_SM4_KEY: KEY })).toBeNull()
    expect(readPhoneLink({ SMS_PHONE_URL: "ftp://x.test", SMS_PHONE_SM4_KEY: KEY })).toBeNull()
    expect(readPhoneLink({ SMS_PHONE_URL: "not a url", SMS_PHONE_SM4_KEY: KEY })).toBeNull()
    expect(readPhoneLink({ SMS_PHONE_URL: "https://relay.example.test", SMS_PHONE_SM4_KEY: KEY.slice(1) })).toBeNull()
  })
})
