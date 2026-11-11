import { describe, it, expect } from "vitest"
import { extractStatementTxids, findMissingClaims, UnknownColumnError } from "./reconcile"

describe("extractStatementTxids", () => {
  it("reads the named column, case-insensitive and trimmed", () => {
    const csv = "Date,Transaction ID,Amount\n2026-11-01,12345678901,10\n2026-11-01,12345678902,20\n"
    expect(extractStatementTxids(csv, "  transaction id ")).toEqual(["12345678901", "12345678902"])
  })

  it("handles a BOM and CRLF line endings", () => {
    const csv = "﻿Id,Amount\r\n12345678901,5\r\n12345678902,6\r\n"
    expect(extractStatementTxids(csv, "Id")).toEqual(["12345678901", "12345678902"])
  })

  it("handles quoted fields with commas and doubled quotes", () => {
    const csv = 'Note,Id\n"hello, ""world""","12345678901"\n"a\nb",12345678902\n'
    expect(extractStatementTxids(csv, "Id")).toEqual(["12345678901", "12345678902"])
  })

  it("keeps only 8-15 digit values and de-duplicates", () => {
    const csv = "Id\n1234567\n12345678\n123456789012345\n1234567890123456\nabc12345678\n 12345678 \n12345678\n"
    expect(extractStatementTxids(csv, "Id")).toEqual(["12345678", "123456789012345"])
  })

  it("throws UnknownColumnError for a missing column", () => {
    expect(() => extractStatementTxids("A,B\n1,2\n", "Id")).toThrow(UnknownColumnError)
  })

  it("treats an unbalanced quote as one field to the end without hanging or throwing", () => {
    const csv = 'Id,Note\n12345678901,"unterminated\n12345678902,x\n'
    expect(extractStatementTxids(csv, "Id")).toEqual(["12345678901"])
  })

  it("returns no ids for a header-only CSV", () => {
    expect(extractStatementTxids("Id,Amount\n", "Id")).toEqual([])
    expect(extractStatementTxids("Id,Amount", "id")).toEqual([])
  })

  it("parses a 1 MB single-line input quickly", () => {
    const csv = "Id," + "x".repeat(1024 * 1024)
    const t0 = Date.now()
    expect(extractStatementTxids(csv, "Id")).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it("throws UnknownColumnError for empty input", () => {
    expect(() => extractStatementTxids("", "Id")).toThrow(UnknownColumnError)
  })
})

describe("findMissingClaims", () => {
  const period = { start: "2026-11-01", end: "2026-11-02" }
  it("returns in-period claims absent from the statement, sorted and unique", () => {
    const claimed = [
      { transactionId: "300", claimedAt: "2026-11-01T00:00:00.000Z" },
      { transactionId: "100", claimedAt: "2026-11-02T23:59:59.999Z" },
      { transactionId: "100", claimedAt: "2026-11-02T10:00:00.000Z" },
      { transactionId: "200", claimedAt: "2026-11-01T12:00:00.000Z" },
    ]
    expect(findMissingClaims(claimed, new Set(["200"]), period)).toEqual(["100", "300"])
  })

  it("ignores claims outside the period", () => {
    const claimed = [
      { transactionId: "1", claimedAt: "2026-10-31T23:59:59.999Z" },
      { transactionId: "2", claimedAt: "2026-11-03T00:00:00.000Z" },
    ]
    expect(findMissingClaims(claimed, new Set(), period)).toEqual([])
  })

  it("ignores claims with an unparseable date", () => {
    expect(findMissingClaims([{ transactionId: "1", claimedAt: "nope" }], new Set(), period)).toEqual([])
  })
})
