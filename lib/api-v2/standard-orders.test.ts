import { describe, it, expect } from "vitest"
import { createHash } from "crypto"
import {
  parseExamBoard,
  parseVoucherQuantity,
  parseOptionalPhone,
  parseOptionalEmail,
  parseResultsBody,
  resultsHash,
  GH_REGIONS,
  parseRegion,
  parseFullName,
  parseLocation,
  parseOccupation,
  parseAfaBody,
  afaHash,
  mapResultsOrder,
  mapVoucher,
  mapAfaOrder,
  mapAfaFulfillment,
  classifyResultsError,
  classifyAfaError,
  resultsErrorResponse,
  afaErrorResponse,
} from "./standard-orders"
import { requestHash } from "./commission"

const RES_BODY = { exam_board: "WASSCE", quantity: 2, reference: "RC-0801" }
const AFA_BODY = {
  reference: "AFA-0801",
  full_name: "Kofi Mensah",
  phone: "0249990801",
  id_type: "Ghana Card",
  id_number: "GHA-123456789-0",
  region: "Greater Accra",
  location: "Accra Central",
}

describe("parseExamBoard", () => {
  it("accepts the three boards case-insensitively and returns the canonical form", () => {
    expect(parseExamBoard("WASSCE")).toEqual({ ok: true, board: "WASSCE" })
    expect(parseExamBoard("wassce")).toEqual({ ok: true, board: "WASSCE" })
    expect(parseExamBoard("Bece")).toEqual({ ok: true, board: "BECE" })
    expect(parseExamBoard("novdec")).toEqual({ ok: true, board: "NOVDEC" })
  })
  it("rejects everything else, naming the three boards", () => {
    for (const v of ["WAEC", "", " WASSCE", "WASSCE ", "SSCE", null, undefined, 1, {}, ["WASSCE"]]) {
      const r = parseExamBoard(v)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/WASSCE.*BECE.*NOVDEC/)
    }
  })
})

describe("parseVoucherQuantity", () => {
  it("accepts 1..max from numbers and digit strings", () => {
    expect(parseVoucherQuantity(1, 15)).toEqual({ ok: true, quantity: 1 })
    expect(parseVoucherQuantity(15, 15)).toEqual({ ok: true, quantity: 15 })
    expect(parseVoucherQuantity("3", 15)).toEqual({ ok: true, quantity: 3 })
    expect(parseVoucherQuantity(2, 2)).toEqual({ ok: true, quantity: 2 })
  })
  it("rejects 0, over max, fractions, exponents, signs, spaces, non-finite and non-numbers", () => {
    const bad: unknown[] = [
      0, 16, -1, 1.5, "1.5", "1e1", "0", "16", "-1", "+1", " 3", "3 ", "", "abc", "0x10",
      NaN, Infinity, -Infinity, 1e21, 1e309, "99999999999999999999999", Number.MAX_SAFE_INTEGER,
      null, undefined, true, [], {}, [3],
    ]
    for (const v of bad) expect(parseVoucherQuantity(v, 15).ok, String(v)).toBe(false)
  })
  it("respects the max it is given", () => {
    expect(parseVoucherQuantity(6, 5).ok).toBe(false)
    expect(parseVoucherQuantity(5, 5).ok).toBe(true)
  })
  it("rejects when max itself is not a usable positive integer (fail closed)", () => {
    expect(parseVoucherQuantity(1, 0).ok).toBe(false)
    expect(parseVoucherQuantity(1, NaN).ok).toBe(false)
  })
})

describe("parseOptionalPhone", () => {
  it("is null when absent or blank", () => {
    for (const v of [undefined, null, "", "   "]) expect(parseOptionalPhone(v)).toEqual({ ok: true, local: null })
  })
  it("normalises every accepted spelling to the LOCAL form", () => {
    for (const v of ["0249990801", "+233249990801", "233249990801", "024 999 0801", "024-999-0801"]) {
      expect(parseOptionalPhone(v)).toEqual({ ok: true, local: "0249990801" })
    }
  })
  it("rejects invalid numbers and non-strings", () => {
    for (const v of ["12345", "0149990801", "02499908011", "abc", 249990801, {}, true]) {
      expect(parseOptionalPhone(v).ok, String(v)).toBe(false)
    }
  })
})

describe("parseOptionalEmail", () => {
  it("is null when absent or blank", () => {
    for (const v of [undefined, null, "", "  "]) expect(parseOptionalEmail(v)).toEqual({ ok: true, email: null })
  })
  it("lowercases and trims", () => {
    expect(parseOptionalEmail("  Kofi.Mensah@Example.COM ")).toEqual({ ok: true, email: "kofi.mensah@example.com" })
  })
  it("rejects malformed addresses, control chars and non-strings", () => {
    const bad: unknown[] = ["a", "a@b", "@b.com", "a@", "a b@c.com", "a@b..com", "a@@b.com", "a@b.com\n", "a@b.com, c@d.com", "a@-b.com", 5, {}, true]
    for (const v of bad) expect(parseOptionalEmail(v).ok, String(v)).toBe(false)
  })
  it("enforces 254 characters", () => {
    const ok = "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(57) + ".com"
    expect(ok.length).toBeLessThanOrEqual(254)
    expect(parseOptionalEmail(ok).ok).toBe(true)
    const tooLong = "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(63) + ".example.com"
    expect(tooLong.length).toBeGreaterThan(254)
    expect(parseOptionalEmail(tooLong).ok).toBe(false)
  })
})

describe("parseResultsBody", () => {
  it("parses a minimal body", () => {
    expect(parseResultsBody(RES_BODY, 15)).toEqual({
      ok: true,
      value: { board: "WASSCE", quantity: 2, reference: "RC-0801", recipientPhone: null, recipientEmail: null },
    })
  })
  it("parses optional recipients into local phone and lowercased email", () => {
    const r = parseResultsBody(
      { ...RES_BODY, exam_board: "bece", quantity: "3", recipient_phone: "+233249990802", recipient_email: "A@B.com" },
      15
    )
    expect(r).toEqual({
      ok: true,
      value: { board: "BECE", quantity: 3, reference: "RC-0801", recipientPhone: "0249990802", recipientEmail: "a@b.com" },
    })
  })
  it("rejects non-objects", () => {
    for (const b of [null, undefined, [], "x", 1]) expect(parseResultsBody(b, 15).ok).toBe(false)
  })
  it("rejects forbidden fields in any case before anything else", () => {
    const fields = ["price", "amount", "total", "unit_price", "quantity_price", "status", "user_id", "shop_id", "fee", "markup", "api_key_id", "package_id", "dealer_price", "AMOUNT", "Unit_Price", "Shop_Id"]
    for (const f of fields) {
      // body is otherwise invalid too: the forbidden-field error must win
      const r = parseResultsBody({ exam_board: "nope", quantity: 0, [f]: 1 }, 15)
      expect(r, f).toEqual({ ok: false, error: "Unexpected field" })
    }
  })
  it("reports field errors", () => {
    expect(parseResultsBody({ ...RES_BODY, exam_board: "WAEC" }, 15).ok).toBe(false)
    expect(parseResultsBody({ ...RES_BODY, quantity: 16 }, 15).ok).toBe(false)
    expect(parseResultsBody({ ...RES_BODY, reference: "x" }, 15).ok).toBe(false)
    expect(parseResultsBody({ ...RES_BODY, recipient_phone: "bad" }, 15).ok).toBe(false)
    expect(parseResultsBody({ ...RES_BODY, recipient_email: "bad" }, 15).ok).toBe(false)
    expect(parseResultsBody({ exam_board: "WASSCE", quantity: 1 }, 15).ok).toBe(false)
  })
})

describe("resultsHash", () => {
  const base = parseResultsBody(RES_BODY, 15)
  if (!base.ok) throw new Error("setup")
  it("is a stable sha256 hex", () => {
    expect(resultsHash(base.value)).toMatch(/^[0-9a-f]{64}$/)
    expect(resultsHash(base.value)).toBe(resultsHash({ ...base.value }))
  })
  it("matches requestHash over the canonical request and ignores the reference", () => {
    expect(resultsHash(base.value)).toBe(
      requestHash("results", { board: "WASSCE", quantity: 2, recipient_phone: null, recipient_email: null })
    )
    expect(resultsHash({ ...base.value, reference: "RC-OTHER" })).toBe(resultsHash(base.value))
  })
  it("is equal across spellings of the same request", () => {
    const a = parseResultsBody({ ...RES_BODY, exam_board: "wassce", quantity: "2", recipient_phone: "+233249990803", recipient_email: " X@Y.com " }, 15)
    const b = parseResultsBody({ ...RES_BODY, exam_board: "WASSCE", quantity: 2, recipient_phone: "024 999 0803", recipient_email: "x@y.com" }, 15)
    if (!a.ok || !b.ok) throw new Error("setup")
    expect(resultsHash(a.value)).toBe(resultsHash(b.value))
  })
  it("differs when board, quantity, phone or email differ", () => {
    const h = resultsHash(base.value)
    expect(resultsHash({ ...base.value, board: "BECE" })).not.toBe(h)
    expect(resultsHash({ ...base.value, quantity: 3 })).not.toBe(h)
    expect(resultsHash({ ...base.value, recipientPhone: "0249990804" })).not.toBe(h)
    expect(resultsHash({ ...base.value, recipientEmail: "a@b.com" })).not.toBe(h)
  })
  it("never collides with the same canonical object under another kind", () => {
    const canon = { board: "WASSCE", quantity: 2, recipient_phone: null, recipient_email: null }
    expect(requestHash("afa", canon)).not.toBe(resultsHash(base.value))
    expect(requestHash("airtime", canon)).not.toBe(resultsHash(base.value))
  })
})

describe("GH_REGIONS / parseRegion", () => {
  it("lists exactly the 16 official regions", () => {
    expect([...GH_REGIONS]).toEqual([
      "Ahafo", "Ashanti", "Bono", "Bono East", "Central", "Eastern", "Greater Accra", "North East",
      "Northern", "Oti", "Savannah", "Upper East", "Upper West", "Volta", "Western", "Western North",
    ])
  })
  it("maps every region from its own name, lowercased and upper-cased", () => {
    for (const r of GH_REGIONS) {
      expect(parseRegion(r)).toEqual({ ok: true, region: r })
      expect(parseRegion(r.toLowerCase())).toEqual({ ok: true, region: r })
      expect(parseRegion(r.toUpperCase())).toEqual({ ok: true, region: r })
    }
  })
  it("is case- and repeated-space-insensitive", () => {
    expect(parseRegion("greater accra")).toEqual({ ok: true, region: "Greater Accra" })
    expect(parseRegion("GREATER  ACCRA")).toEqual({ ok: true, region: "Greater Accra" })
    expect(parseRegion("  western   north ")).toEqual({ ok: true, region: "Western North" })
  })
  it("rejects unknown regions, near misses and non-strings", () => {
    for (const v of ["Accra", "Greater-Accra", "GreaterAccra", "Brong Ahafo", "Western  Northx", "", null, undefined, 1, {}]) {
      expect(parseRegion(v).ok, String(v)).toBe(false)
    }
  })
  it("is not fooled by prototype keys", () => {
    for (const v of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(parseRegion(v).ok).toBe(false)
  })
})

describe("parseFullName / parseLocation / parseOccupation", () => {
  it("normalises names: trim and single-space", () => {
    expect(parseFullName("  Kofi   Mensah ")).toEqual({ ok: true, name: "Kofi Mensah" })
    expect(parseFullName("Ama-Serwaa O'Neil")).toEqual({ ok: true, name: "Ama-Serwaa O'Neil" })
    expect(parseFullName("Yaa Ås")).toEqual({ ok: true, name: "Yaa Ås" })
  })
  it("enforces 3..100 characters", () => {
    expect(parseFullName("Al").ok).toBe(false)
    expect(parseFullName("Ali").ok).toBe(true)
    expect(parseFullName("a".repeat(100)).ok).toBe(true)
    expect(parseFullName("a".repeat(101)).ok).toBe(false)
  })
  it("needs at least two letters", () => {
    for (const v of ["123", "1 2 3", "---", "A 12", "...", "A--"]) expect(parseFullName(v).ok, v).toBe(false)
    expect(parseFullName("A 1B").ok).toBe(true)
  })
  it("rejects control characters and non-strings", () => {
    for (const v of ["Kofi\nMensah", "Kofi\tMensah", "Kofi\u0000Mensah", "Kofi\u007fMensah", "Kofi\u0085Mensah", null, undefined, 5, {}]) {
      expect(parseFullName(v).ok, JSON.stringify(v)).toBe(false)
    }
  })
  it("location: trimmed, 2..120, no control chars", () => {
    expect(parseLocation("  Accra  ")).toEqual({ ok: true, location: "Accra" })
    expect(parseLocation("A").ok).toBe(false)
    expect(parseLocation(" A ").ok).toBe(false)
    expect(parseLocation("ab").ok).toBe(true)
    expect(parseLocation("a".repeat(120)).ok).toBe(true)
    expect(parseLocation("a".repeat(121)).ok).toBe(false)
    expect(parseLocation("Acc\nra").ok).toBe(false)
    expect(parseLocation(undefined).ok).toBe(false)
    expect(parseLocation(5).ok).toBe(false)
  })
  it("occupation: optional, trimmed, <= 80, no control chars", () => {
    for (const v of [undefined, null, "", "   "]) expect(parseOccupation(v)).toEqual({ ok: true, occupation: null })
    expect(parseOccupation(" Trader ")).toEqual({ ok: true, occupation: "Trader" })
    expect(parseOccupation("a".repeat(80)).ok).toBe(true)
    expect(parseOccupation("a".repeat(81)).ok).toBe(false)
    expect(parseOccupation("a\nb").ok).toBe(false)
    expect(parseOccupation(5).ok).toBe(false)
  })
})

describe("parseAfaBody", () => {
  it("parses a valid body", () => {
    expect(parseAfaBody(AFA_BODY)).toEqual({
      ok: true,
      value: {
        reference: "AFA-0801",
        fullName: "Kofi Mensah",
        phone: { msisdn: "233249990801", local: "0249990801" },
        cardCanonical: "GHA-123456789-0",
        region: "Greater Accra",
        location: "Accra Central",
        occupation: null,
      },
    })
  })
  it("canonicalises every Ghana Card spelling the real parser accepts", () => {
    for (const id of ["GHA-123456789-0", "gha-123456789-0", "GHA1234567890", "1234567890", "123456789-0", "GHA 123456789 0", " gha123456789-0 "]) {
      const r = parseAfaBody({ ...AFA_BODY, id_number: id })
      expect(r.ok, id).toBe(true)
      if (r.ok) expect(r.value.cardCanonical).toBe("GHA-123456789-0")
    }
  })
  it("rejects bad cards without ever echoing the number", () => {
    for (const id of ["GHA-12345678-0", "GHA-12345678901", "GHA-12345678A-0", "GHB-123456789-0", "", "   ", 1234567890, null, {}]) {
      const r = parseAfaBody({ ...AFA_BODY, id_number: id })
      expect(r.ok, String(id)).toBe(false)
      if (!r.ok && typeof id === "string" && id.trim()) {
        expect(r.error).not.toContain(id.trim())
        expect(r.error).not.toMatch(/\d{6}/)
      }
    }
  })
  it("requires id_type to be Ghana Card, case-insensitively", () => {
    for (const t of ["Ghana Card", "ghana card", "GHANA CARD", " Ghana Card "]) expect(parseAfaBody({ ...AFA_BODY, id_type: t }).ok, t).toBe(true)
    for (const t of ["Passport", "Voters ID", "GhanaCard", "", undefined, null, 1]) expect(parseAfaBody({ ...AFA_BODY, id_type: t }).ok, String(t)).toBe(false)
    expect(parseAfaBody({ ...AFA_BODY, id_type: undefined }).ok).toBe(false)
  })
  it("normalises the phone and rejects a bad one", () => {
    const r = parseAfaBody({ ...AFA_BODY, phone: "+233 24 999 0802" })
    expect(r.ok && r.value.phone).toEqual({ msisdn: "233249990802", local: "0249990802" })
    expect(parseAfaBody({ ...AFA_BODY, phone: "123" }).ok).toBe(false)
    expect(parseAfaBody({ ...AFA_BODY, phone: undefined }).ok).toBe(false)
  })
  it("validates region, name, location and occupation", () => {
    expect(parseAfaBody({ ...AFA_BODY, region: "greater  accra" }).ok).toBe(true)
    expect(parseAfaBody({ ...AFA_BODY, region: "Accra" }).ok).toBe(false)
    expect(parseAfaBody({ ...AFA_BODY, full_name: "A" }).ok).toBe(false)
    expect(parseAfaBody({ ...AFA_BODY, location: "x" }).ok).toBe(false)
    const occ = parseAfaBody({ ...AFA_BODY, occupation: " Trader " })
    expect(occ.ok && occ.value.occupation).toBe("Trader")
    expect(parseAfaBody({ ...AFA_BODY, occupation: "x".repeat(81) }).ok).toBe(false)
    expect(parseAfaBody({ ...AFA_BODY, reference: "!" }).ok).toBe(false)
  })
  it("ignores date_of_birth (neither required nor forbidden, never carried)", () => {
    const r = parseAfaBody({ ...AFA_BODY, date_of_birth: "1990-01-01" })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain("1990")
    expect(parseAfaBody({ ...AFA_BODY, date_of_birth: "garbage" }).ok).toBe(true)
  })
  it("rejects forbidden fields case-insensitively before anything else", () => {
    for (const f of ["amount", "price", "status", "user_id", "unit_price", "shop_id", "markup", "api_key_id", "package_id", "dealer_price", "total", "fee", "AMOUNT", "User_Id"]) {
      expect(parseAfaBody({ full_name: "x", [f]: 1 }), f).toEqual({ ok: false, error: "Unexpected field" })
    }
  })
  it("rejects non-objects", () => {
    for (const b of [null, undefined, [], "x", 1]) expect(parseAfaBody(b).ok).toBe(false)
  })
})

describe("afaHash", () => {
  const parse = (over: Record<string, unknown> = {}) => {
    const r = parseAfaBody({ ...AFA_BODY, ...over })
    if (!r.ok) throw new Error("setup " + r.error)
    return r.value
  }
  it("is stable sha256 hex and hashes the card before the canonical JSON", () => {
    const v = parse()
    const h = afaHash(v)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    const cardSha = createHash("sha256").update("GHA-123456789-0").digest("hex")
    expect(h).toBe(
      requestHash("afa", {
        card: cardSha,
        full_name: "Kofi Mensah",
        phone: "0249990801",
        region: "Greater Accra",
        location: "Accra Central",
        occupation: null,
      })
    )
  })
  it("never contains the card number in anything hashed (card only appears as its sha256)", () => {
    // the canonical string is not exposed, but the same request spelled differently must match
    expect(afaHash(parse({ id_number: "gha1234567890" }))).toBe(afaHash(parse()))
  })
  it("is equal across spellings of the same registration", () => {
    const a = parse({ full_name: "  Kofi   Mensah ", phone: "+233249990801", id_number: "1234567890", id_type: "ghana card", reference: "AFA-X1" })
    expect(afaHash(a)).toBe(afaHash(parse()))
  })
  it("is equal across region case, location padding and occupation padding", () => {
    const a = parse({ region: "GREATER  ACCRA", location: "  Accra Central ", occupation: " Trader " })
    const b = parse({ region: "greater accra", location: "Accra Central", occupation: "Trader" })
    expect(afaHash(a)).toBe(afaHash(b))
  })
  it("differs on region, location or occupation", () => {
    const h = afaHash(parse())
    expect(afaHash(parse({ region: "Ashanti" }))).not.toBe(h)
    expect(afaHash(parse({ location: "Kumasi" }))).not.toBe(h)
    expect(afaHash(parse({ occupation: "Trader" }))).not.toBe(h)
    expect(afaHash(parse({ occupation: "Trader" }))).not.toBe(afaHash(parse({ occupation: "Farmer" })))
  })
  it("differs on card, name or phone", () => {
    const h = afaHash(parse())
    expect(afaHash(parse({ id_number: "GHA-123456789-1" }))).not.toBe(h)
    expect(afaHash(parse({ full_name: "Kofi Mensah Jr" }))).not.toBe(h)
    expect(afaHash(parse({ phone: "0249990802" }))).not.toBe(h)
  })
})

describe("mapResultsOrder / mapVoucher / mapAfaFulfillment / mapAfaOrder", () => {
  const internal = {
    id: "uuid-1",
    user_id: "user-1",
    shop_id: "shop-1",
    reference_code: "RC-ABC",
    inventory_ids: ["i1", "i2"],
    merchant_commission: 1.5,
    fee_amount: 0,
    payment_status: "completed",
    notes: "secret",
    updated_at: "2026-10-26T00:00:00Z",
  }
  it("results: exactly the allow-list, numbers to 2dp", () => {
    const out = mapResultsOrder(
      { ...internal, exam_board: "WASSCE", quantity: 2, unit_price: "17.5", total_paid: 35.005, status: "completed", created_at: "2026-10-26T01:02:03Z" },
      "RC-0801"
    )
    expect(out).toEqual({
      reference: "RC-0801",
      exam_board: "WASSCE",
      quantity: 2,
      unit_price: 17.5,
      total_paid: 35.01,
      status: "completed",
      created_at: "2026-10-26T01:02:03Z",
    })
    expect(Object.keys(out).sort()).toEqual(["created_at", "exam_board", "quantity", "reference", "status", "total_paid", "unit_price"])
  })
  it("results: tolerates null or odd rows without leaking or throwing", () => {
    const out = mapResultsOrder(null, "RC-0801")
    expect(Object.keys(out).sort()).toEqual(["created_at", "exam_board", "quantity", "reference", "status", "total_paid", "unit_price"])
    expect(out).toMatchObject({ reference: "RC-0801", quantity: 0, unit_price: 0, total_paid: 0, created_at: null })
  })
  it("status mapping, unknown reads processing", () => {
    const st = (s: unknown) => mapResultsOrder({ status: s }, "r").status
    expect(st("completed")).toBe("completed")
    expect(st("pending")).toBe("pending")
    expect(st("pending_payment")).toBe("pending")
    expect(st("processing")).toBe("processing")
    expect(st("failed")).toBe("failed")
    expect(st("refunded")).toBe("refunded")
    expect(st("weird")).toBe("processing")
    expect(st(undefined)).toBe("processing")
    expect(st(null)).toBe("processing")
    expect(st(5)).toBe("processing")
  })
  it("voucher: only pin and serial_number", () => {
    const out = mapVoucher({ id: "v1", order_id: "o1", pin: "123456", serial_number: "S-1", exam_board: "WASSCE", status: "sold", inventory_id: "x" })
    expect(out).toEqual({ pin: "123456", serial_number: "S-1" })
    expect(Object.keys(out).sort()).toEqual(["pin", "serial_number"])
    expect(mapVoucher(null)).toEqual({ pin: "", serial_number: "" })
  })
  it("fulfillment mapping: fulfilled, pending, failed; unknown reads pending", () => {
    expect(mapAfaFulfillment("fulfilled")).toBe("fulfilled")
    expect(mapAfaFulfillment("pending")).toBe("pending")
    expect(mapAfaFulfillment("failed")).toBe("failed")
    expect(mapAfaFulfillment("unfulfilled")).toBe("pending")
    expect(mapAfaFulfillment("weird")).toBe("pending")
    expect(mapAfaFulfillment(null)).toBe("pending")
    expect(mapAfaFulfillment(undefined)).toBe("pending")
    expect(mapAfaFulfillment(3)).toBe("pending")
    expect(mapAfaFulfillment(" FULFILLED ")).toBe("fulfilled")
  })
  it("afa: exactly the allow-list with LOCAL phone and no card, even with internal columns", () => {
    const out = mapAfaOrder(
      {
        ...internal,
        order_code: "AFA-1234567",
        transaction_code: "tx-secret",
        gh_card_number: "GHA-123456789-0",
        occupation: "Trader",
        location: "Accra",
        fulfillment_status: "fulfilled",
        fulfillment_attempts: 2,
        fulfillment_error: "boom",
        full_name: "Kofi Mensah",
        phone_number: "233249990801",
        region: "Greater Accra",
        amount: "25",
        status: "pending",
        created_at: "2026-10-26T01:02:03Z",
      },
      "AFA-0801"
    )
    expect(out).toEqual({
      reference: "AFA-0801",
      full_name: "Kofi Mensah",
      phone: "0249990801",
      region: "Greater Accra",
      amount: 25,
      status: "pending",
      fulfillment: "fulfilled",
      created_at: "2026-10-26T01:02:03Z",
    })
    expect(Object.keys(out).sort()).toEqual(["amount", "created_at", "fulfillment", "full_name", "phone", "reference", "region", "status"])
    expect(JSON.stringify(out)).not.toContain("123456789")
  })
  it("afa: local phone from every stored spelling, unknown fulfillment reads pending, null row is safe", () => {
    expect(mapAfaOrder({ phone_number: "0249990801" }, "r").phone).toBe("0249990801")
    expect(mapAfaOrder({ phone_number: "+233249990801" }, "r").phone).toBe("0249990801")
    expect(mapAfaOrder({ fulfillment_status: "???" }, "r").fulfillment).toBe("pending")
    const n = mapAfaOrder(null, "r")
    expect(Object.keys(n).sort()).toEqual(["amount", "created_at", "fulfillment", "full_name", "phone", "reference", "region", "status"])
    expect(n.status).toBe("processing")
  })
})

describe("classifyResultsError", () => {
  it("INSUFFICIENT_BALANCE is no_charge", () => {
    expect(classifyResultsError("INSUFFICIENT_BALANCE")).toBe("no_charge")
  })
  it("INSUFFICIENT_INVENTORY is ambiguous (thrown after a debit and an unchecked refund)", () => {
    expect(classifyResultsError("INSUFFICIENT_INVENTORY")).toBe("ambiguous")
  })
  it("everything else is ambiguous", () => {
    for (const c of ["PAYMENT_FAILED", "ORDER_CREATE_FAILED", "NETWORK_DISABLED", "", "insufficient_balance", undefined, null, 402, {}, ["INSUFFICIENT_BALANCE"], true]) {
      expect(classifyResultsError(c), String(c)).toBe("ambiguous")
    }
  })
})

describe("classifyAfaError", () => {
  it("pre-debit codes are no_charge", () => {
    for (const c of ["INVALID_GHANA_CARD", "PRICE_UNAVAILABLE", "INSUFFICIENT_BALANCE"]) expect(classifyAfaError(c), c).toBe("no_charge")
  })
  it("PAYMENT_FAILED and ORDER_CREATE_FAILED are ambiguous", () => {
    expect(classifyAfaError("PAYMENT_FAILED")).toBe("ambiguous")
    expect(classifyAfaError("ORDER_CREATE_FAILED")).toBe("ambiguous")
  })
  it("uncoded, unknown, results-only and non-string codes are ambiguous", () => {
    for (const c of ["INSUFFICIENT_INVENTORY", "WHATEVER", "", "invalid_ghana_card", undefined, null, 0, {}, ["PRICE_UNAVAILABLE"], false]) {
      expect(classifyAfaError(c), String(c)).toBe("ambiguous")
    }
  })
})

describe("resultsErrorResponse / afaErrorResponse", () => {
  it("results: 402 with required, 503 inventory, 500 otherwise, engine text never forwarded", () => {
    const bal = resultsErrorResponse({ code: "INSUFFICIENT_BALANCE", required: 35.005, message: "db host x" })
    expect(bal).toMatchObject({ status: 402, code: "INSUFFICIENT_BALANCE", required: 35.01 })
    expect(bal.message).toContain("35.01")
    expect(bal.message).not.toContain("db host")
    expect(resultsErrorResponse({ code: "INSUFFICIENT_BALANCE" })).toMatchObject({ status: 402, code: "INSUFFICIENT_BALANCE" })
    expect("required" in resultsErrorResponse({ code: "INSUFFICIENT_BALANCE" })).toBe(false)
    expect(resultsErrorResponse({ code: "INSUFFICIENT_INVENTORY" })).toMatchObject({ status: 503, code: "INSUFFICIENT_INVENTORY" })
    for (const e of [new Error("Failed to create order. Wallet refunded."), null, undefined, "boom", { code: 5 }, {}]) {
      expect(resultsErrorResponse(e)).toMatchObject({ status: 500, code: "INTERNAL_ERROR" })
    }
  })
  it("afa: fixed statuses and messages", () => {
    expect(afaErrorResponse({ code: "INVALID_GHANA_CARD", message: "Got: GHA-123456789-0" })).toMatchObject({ status: 400, code: "INVALID_GHANA_CARD" })
    expect(JSON.stringify(afaErrorResponse({ code: "INVALID_GHANA_CARD", message: "Got: GHA-123456789-0" }))).not.toContain("123456789")
    expect(afaErrorResponse({ code: "PRICE_UNAVAILABLE" })).toMatchObject({ status: 503, code: "PRICE_UNAVAILABLE" })
    expect(afaErrorResponse({ code: "INSUFFICIENT_BALANCE", required: 25 })).toMatchObject({ status: 402, code: "INSUFFICIENT_BALANCE", required: 25 })
    expect(afaErrorResponse({ code: "PAYMENT_FAILED" })).toMatchObject({ status: 500, code: "PAYMENT_FAILED" })
    expect(afaErrorResponse({ code: "ORDER_CREATE_FAILED" })).toMatchObject({ status: 500, code: "ORDER_CREATE_FAILED" })
    for (const e of [null, undefined, "x", {}, { code: "NOPE" }]) expect(afaErrorResponse(e)).toMatchObject({ status: 500, code: "INTERNAL_ERROR" })
  })
})
