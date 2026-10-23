import { describe, it, expect } from "vitest"
import {
  parseNetwork,
  normalizeRecipient,
  parseVolume,
  parseReference,
  parsePurchaseBody,
  parseBulkBody,
  priceForRole,
  mapOrderStatus,
  mapOrder,
  findPackage,
  type PackageRow,
} from "./data-orders"

describe("parseNetwork", () => {
  it("accepts the four canonical names case-insensitively", () => {
    expect(parseNetwork("MTN")).toEqual({ ok: true, network: "MTN", dbNetwork: "MTN" })
    expect(parseNetwork("mtn")).toEqual({ ok: true, network: "MTN", dbNetwork: "MTN" })
    expect(parseNetwork("TELECEL")).toEqual({ ok: true, network: "Telecel", dbNetwork: "Telecel" })
    expect(parseNetwork("at-ishare")).toEqual({ ok: true, network: "AT-iShare", dbNetwork: "AT - iShare" })
    expect(parseNetwork("AT-BIGTIME")).toEqual({ ok: true, network: "AT-BigTime", dbNetwork: "AT - BigTime" })
  })
  it("accepts the spaced DB forms in any case", () => {
    expect(parseNetwork("AT - iShare")).toEqual({ ok: true, network: "AT-iShare", dbNetwork: "AT - iShare" })
    expect(parseNetwork("at - bigtime")).toEqual({ ok: true, network: "AT-BigTime", dbNetwork: "AT - BigTime" })
  })
  it("rejects everything else and lists the valid names", () => {
    for (const v of ["", "vodafone", "AT", "MTN%", " MTN", "MTN ", null, undefined, 5, ["MTN"], {}]) {
      const r = parseNetwork(v)
      expect(r.ok).toBe(false)
      if (!r.ok) for (const n of ["MTN", "Telecel", "AT-iShare", "AT-BigTime"]) expect(r.error).toContain(n)
    }
  })
})

describe("normalizeRecipient", () => {
  const want = { ok: true, msisdn: "233244123456", local: "0244123456" }
  it("normalises every accepted form identically", () => {
    expect(normalizeRecipient("0244123456")).toEqual(want)
    expect(normalizeRecipient("233244123456")).toEqual(want)
    expect(normalizeRecipient("+233244123456")).toEqual(want)
    expect(normalizeRecipient("024 412-3456")).toEqual(want)
    expect(normalizeRecipient("+233 24 412 3456")).toEqual(want)
  })
  it("accepts 02x, 03x, 05x prefixes", () => {
    expect(normalizeRecipient("0204123456").ok).toBe(true)
    expect(normalizeRecipient("0304123456").ok).toBe(true)
    expect(normalizeRecipient("0504123456").ok).toBe(true)
  })
  it("rejects bad input", () => {
    const bad: unknown[] = [
      "244123456",
      "024412345",
      "02441234567",
      "abc",
      "",
      ["0244123456"],
      244123456,
      "0244123456\n",
      "\n0244123456",
      "0144123456",
      "0644123456",
      "2330144123456",
      null,
      undefined,
    ]
    for (const v of bad) expect(normalizeRecipient(v).ok).toBe(false)
  })
})

describe("parseVolume", () => {
  it("accepts valid volumes", () => {
    expect(parseVolume("1")).toEqual({ ok: true, gb: 1 })
    expect(parseVolume(1)).toEqual({ ok: true, gb: 1 })
    expect(parseVolume(1.0)).toEqual({ ok: true, gb: 1 })
    expect(parseVolume("1.5")).toEqual({ ok: true, gb: 1.5 })
    expect(parseVolume(0.001)).toEqual({ ok: true, gb: 0.001 })
    expect(parseVolume(1000)).toEqual({ ok: true, gb: 1000 })
  })
  it("rejects invalid volumes", () => {
    const bad: unknown[] = [0, -1, NaN, Infinity, "1e3", 1001, 1.2345, "1.2345", "", " 1", "abc", null, undefined, [1], "0", "-1", 1e-7]
    for (const v of bad) expect(parseVolume(v).ok).toBe(false)
  })
})

describe("parseReference", () => {
  it("accepts valid references and trims", () => {
    expect(parseReference("ABC-123_x.y:z")).toEqual({ ok: true, reference: "ABC-123_x.y:z" })
    expect(parseReference("  abc  ")).toEqual({ ok: true, reference: "abc" })
    expect(parseReference("a".repeat(100)).ok).toBe(true)
  })
  it("rejects invalid references", () => {
    const bad: unknown[] = ["ab", "a".repeat(101), "has space", "unicodé", "emoji\u{1F600}x", "a/b/c", 123, null, undefined, ["abc"], "ab\ncd"]
    for (const v of bad) expect(parseReference(v).ok).toBe(false)
  })
})

const goodBody = { network: "mtn", volume_gb: 1, recipient: "0249990201", reference: "REF-001" }

describe("parsePurchaseBody", () => {
  it("parses a valid body", () => {
    expect(parsePurchaseBody(goodBody)).toEqual({
      ok: true,
      value: { network: "MTN", dbNetwork: "MTN", gb: 1, msisdn: "233249990201", local: "0249990201", reference: "REF-001" },
    })
  })
  it.each(["price", "amount", "package_id", "status", "user_id", "total"])("rejects %s", (k) => {
    const r = parsePurchaseBody({ ...goodBody, [k]: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("Unexpected field")
  })
  it("rejects non-objects and invalid members", () => {
    for (const b of [null, undefined, "x", 5, [], [goodBody]]) expect(parsePurchaseBody(b).ok).toBe(false)
    expect(parsePurchaseBody({ ...goodBody, network: "x" }).ok).toBe(false)
    expect(parsePurchaseBody({ ...goodBody, volume_gb: 0 }).ok).toBe(false)
    expect(parsePurchaseBody({ ...goodBody, recipient: "1" }).ok).toBe(false)
    expect(parsePurchaseBody({ ...goodBody, reference: "x" }).ok).toBe(false)
  })
})

describe("parseBulkBody", () => {
  const item = (n: number) => ({ ...goodBody, reference: `REF-${n}`, recipient: "0249990202" })
  it("parses 1..100 items", () => {
    const r = parseBulkBody({ orders: [item(1), item(2)] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.items).toHaveLength(2)
    expect(parseBulkBody({ orders: Array.from({ length: 100 }, (_, i) => item(i + 1)) }).ok).toBe(true)
  })
  it("rejects 0 and 101 items and non-arrays", () => {
    expect(parseBulkBody({ orders: [] }).ok).toBe(false)
    expect(parseBulkBody({ orders: Array.from({ length: 101 }, (_, i) => item(i + 1)) }).ok).toBe(false)
    expect(parseBulkBody({}).ok).toBe(false)
    expect(parseBulkBody(null).ok).toBe(false)
    expect(parseBulkBody({ orders: "x" }).ok).toBe(false)
  })
  it("reports the index of an invalid item", () => {
    expect(parseBulkBody({ orders: [item(1), { ...item(2), price: 1 }] })).toMatchObject({ ok: false, index: 1 })
  })
  it("rejects duplicate references and reports the index of the repeat", () => {
    expect(parseBulkBody({ orders: [item(1), item(2), item(1)] })).toMatchObject({ ok: false, index: 2 })
  })
})

describe("priceForRole", () => {
  it("dealer gets the dealer price when positive", () => {
    expect(priceForRole("dealer", { price: 10, dealer_price: 8 })).toBe(8)
    expect(priceForRole("dealer", { price: 10, dealer_price: 0 })).toBe(10)
    expect(priceForRole("dealer", { price: 10, dealer_price: null })).toBe(10)
  })
  it("other roles pay the standard price", () => {
    for (const r of ["user", "sub_agent", "admin"]) expect(priceForRole(r, { price: 10, dealer_price: 8 })).toBe(10)
  })
})

describe("mapOrderStatus", () => {
  it("maps known statuses", () => {
    for (const s of ["pending", "processing", "completed", "failed", "refunded"] as const) expect(mapOrderStatus(s)).toBe(s)
    expect(mapOrderStatus("held_registration")).toBe("queued")
  })
  it("unknown becomes processing", () => {
    expect(mapOrderStatus("weird")).toBe("processing")
    expect(mapOrderStatus(null)).toBe("processing")
    expect(mapOrderStatus(undefined)).toBe("processing")
  })
})

describe("mapOrder", () => {
  const row = {
    api_reference: "REF-1",
    network: "AT - iShare",
    volume_gb: "2",
    price: "9.999",
    recipient_phone: "233249990201",
    status: "held_registration",
    created_at: "2026-01-01T00:00:00Z",
    id: "secret-id",
    provider_reference: "prov",
    error_message: "boom",
    api_key_id: "k",
  }
  it("returns exactly the allow-listed keys", () => {
    const m = mapOrder(row)
    expect(Object.keys(m).sort()).toEqual(["created_at", "network", "price", "recipient", "reference", "status", "volume_gb"])
    expect(m).toEqual({
      reference: "REF-1",
      network: "AT-iShare",
      volume_gb: 2,
      recipient: "0249990201",
      price: 10,
      status: "queued",
      created_at: "2026-01-01T00:00:00Z",
    })
  })
  it("handles +233, local and unknown values", () => {
    expect(mapOrder({ ...row, recipient_phone: "+233249990201" }).recipient).toBe("0249990201")
    expect(mapOrder({ ...row, recipient_phone: "0249990201" }).recipient).toBe("0249990201")
    expect(mapOrder({ ...row, recipient_phone: "weird" }).recipient).toBe("weird")
    expect(mapOrder({ ...row, network: " Foo " }).network).toBe("Foo")
    expect(mapOrder({ ...row, network: "telecel" }).network).toBe("Telecel")
  })
})

describe("findPackage", () => {
  const mk = (size: string, network = "MTN"): PackageRow => ({ id: `p-${network}-${size}`, network, size, price: 5, dealer_price: null })
  it("matches numerically on strict sizes", () => {
    expect(findPackage([mk("1")], "MTN", 1)?.size).toBe("1")
    expect(findPackage([mk("1.0")], "MTN", 1)?.size).toBe("1.0")
    expect(findPackage([mk("10"), mk("2")], "MTN", 2)?.size).toBe("2")
  })
  it("returns null when missing or wrong network", () => {
    expect(findPackage([mk("1")], "MTN", 5)).toBeNull()
    expect(findPackage([mk("1")], "Telecel", 1)).toBeNull()
  })
  it("never matches sizes the SQL regex rejects", () => {
    for (const s of [" 1", "1GB", "1 GB", "1 ", "", "1e0", ".5", "-1", "1,0"]) {
      expect(findPackage([mk(s)], "MTN", 1)).toBeNull()
    }
    expect(findPackage([mk(".5")], "MTN", 0.5)).toBeNull()
  })
})

describe("hardening", () => {
  const body = { network: "mtn", volume_gb: 1, recipient: "0249990301", reference: "REF-301" }
  it.each(["Price", "AMOUNT", "dealer_price", "cost", "api_key_id", "recipient_phone", "package", "user", "Package_Id"])(
    "rejects %s case-insensitively",
    (k) => {
      const r = parsePurchaseBody({ ...body, [k]: 1 })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("Unexpected field")
    }
  )
  it("ignores other unknown fields and a __proto__ key without throwing", () => {
    expect(parsePurchaseBody({ ...body, note: "hi" }).ok).toBe(true)
    const withProto = JSON.parse('{"__proto__":{"price":1},"network":"mtn","volume_gb":1,"recipient":"0249990302","reference":"REF-302"}')
    expect(() => parsePurchaseBody(withProto)).not.toThrow()
    expect(parsePurchaseBody(withProto).ok).toBe(true)
  })
  it("rejects non-ASCII digits for recipient and volume", () => {
    expect(normalizeRecipient("٠٢٤٤١٢٣٤٥٦").ok).toBe(false)
    expect(normalizeRecipient("０２４４１２３４５６").ok).toBe(false)
    expect(parseVolume("١").ok).toBe(false)
    expect(parseVolume("１").ok).toBe(false)
    expect(parseVolume("0x10").ok).toBe(false)
  })
  it("priceForRole treats string, NaN and non-numeric dealer_price safely", () => {
    expect(priceForRole("dealer", { price: 10, dealer_price: "8" as any })).toBe(8)
    expect(priceForRole("dealer", { price: 10, dealer_price: NaN })).toBe(10)
    expect(priceForRole("dealer", { price: 10, dealer_price: "abc" as any })).toBe(10)
  })
  it("bulk: whitespace-only differences are duplicates, case differences are distinct", () => {
    const mk = (ref: string) => ({ ...body, reference: ref })
    expect(parseBulkBody({ orders: [mk("REF-A1"), mk("  REF-A1 ")] })).toMatchObject({ ok: false, index: 1 })
    expect(parseBulkBody({ orders: [mk("REF-A1"), mk("ref-a1")] }).ok).toBe(true)
  })
})
