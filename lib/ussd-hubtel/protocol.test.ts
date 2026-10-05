import { describe, it, expect } from "vitest"
import {
  sanitizeMessage, fitMessage, respond, release, addToCart, parseHubtelRequest,
  toLocalPhone, toE164, secretsMatch, getClientIp, isHubtelFulfillmentIp, USSD_SCREEN_LIMIT,
} from "./protocol"

describe("sanitizeMessage", () => {
  it("strips diacritics and non-ASCII but keeps newlines", () => {
    expect(sanitizeMessage("Café\nÉtoile ₵5 ✓")).toBe("Cafe\nEtoile 5 ")
  })
})

describe("fitMessage", () => {
  const long = "x".repeat(400)
  it("truncates to the USSD limit on USSD", () => {
    const out = fitMessage(long, "USSD")
    expect(out.length).toBe(USSD_SCREEN_LIMIT)
    expect(out.endsWith("...")).toBe(true)
  })
  it("does not truncate on Webstore / Hubtel-App", () => {
    expect(fitMessage(long, "Webstore").length).toBe(400)
    expect(fitMessage(long, "Hubtel-App").length).toBe(400)
  })
})

describe("reply builders", () => {
  it("respond sets mandatory fields", () => {
    const r = respond("S1", "Pick:\n1. A", { clientState: "MAIN" })
    expect(r).toMatchObject({ SessionId: "S1", Type: "response", DataType: "input", FieldType: "number", ClientState: "MAIN" })
    expect(r.Label).toBeTruthy()
  })
  it("release is display/text", () => {
    expect(release("S1", "Bye")).toMatchObject({ Type: "release", DataType: "display", FieldType: "text" })
  })
  it("addToCart carries a sanitised item with 2dp price", () => {
    const r = addToCart("S1", { itemName: "5GB MTN Données", price: 12.3456, message: "Submitted" })
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Donnees", Qty: 1, Price: 12.35 })
    expect(r.DataType).toBe("display")
  })
})

describe("parseHubtelRequest", () => {
  const base = { Type: "Initiation", Mobile: "233200585542", SessionId: "abc", ServiceCode: "713", Message: "*713#", Operator: "mtn", Sequence: 1, ClientState: "", Platform: "USSD" }
  it("parses a valid initiation", () => {
    expect(parseHubtelRequest(base)).toMatchObject({ Type: "Initiation", SessionId: "abc", Platform: "USSD" })
  })
  it("is case-insensitive on Type and defaults unknown Platform to USSD", () => {
    expect(parseHubtelRequest({ ...base, Type: "response", Platform: "weird" })).toMatchObject({ Type: "Response", Platform: "USSD" })
  })
  it("keeps Webstore and Hubtel-App platforms", () => {
    expect(parseHubtelRequest({ ...base, Platform: "Webstore" })?.Platform).toBe("Webstore")
    expect(parseHubtelRequest({ ...base, Platform: "Hubtel-App" })?.Platform).toBe("Hubtel-App")
  })
  it("rejects missing SessionId / Mobile / bad Type / non-objects", () => {
    expect(parseHubtelRequest({ ...base, SessionId: "" })).toBeNull()
    expect(parseHubtelRequest({ ...base, Mobile: undefined })).toBeNull()
    expect(parseHubtelRequest({ ...base, Type: "Nope" })).toBeNull()
    expect(parseHubtelRequest(null)).toBeNull()
    expect(parseHubtelRequest("x")).toBeNull()
  })
})

describe("phone helpers", () => {
  it("normalises every Ghana format", () => {
    for (const m of ["233200585542", "+233200585542", "0200585542"]) {
      expect(toLocalPhone(m)).toBe("0200585542")
      expect(toE164(m)).toBe("+233200585542")
    }
  })
})

describe("secretsMatch", () => {
  it("matches only equal non-empty secrets", () => {
    expect(secretsMatch("abc", "abc")).toBe(true)
    expect(secretsMatch("abd", "abc")).toBe(false)
    expect(secretsMatch(null, "abc")).toBe(false)
    expect(secretsMatch("abc", undefined)).toBe(false)
    expect(secretsMatch("", "")).toBe(false)
  })
})

describe("ip helpers", () => {
  it("takes the first x-forwarded-for entry", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "52.50.116.54, 10.0.0.1" }))).toBe("52.50.116.54")
    expect(getClientIp(new Headers())).toBeNull()
  })
  it("recognises Hubtel fulfilment IPs", () => {
    expect(isHubtelFulfillmentIp("18.202.122.131")).toBe(true)
    expect(isHubtelFulfillmentIp("1.2.3.4")).toBe(false)
    expect(isHubtelFulfillmentIp(null)).toBe(false)
  })
})
