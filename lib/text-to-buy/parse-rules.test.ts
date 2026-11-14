import { describe, it, expect } from "vitest"
import { parseOrderText, extractGhanaNumbers } from "./parse-rules"

const order = (sizeMb: number, networkHint: any = null, recipient: string | null = null, bare = false) =>
  ({ kind: "order", service: "data", sizeMb, networkHint, recipient, bare })

describe("parseOrderText", () => {
  it.each([
    ["5", order(5000, null, null, true)],
    ["5gb", order(5000)],
    ["5 GB", order(5000)],
    ["5gig", order(5000)],
    ["5 gigs", order(5000)],
    ["5g", order(5000)],
    ["500mb", order(500)],
    ["1.5gb", order(1500)],
    ["mtn 5gb", order(5000, "MTN")],
    ["5gb mtn", order(5000, "MTN")],
    ["telecel 2gb", order(2000, "Telecel")],
    ["voda 2gb", order(2000, "Telecel")],
    ["at 3gb", order(3000, "AT")],
    ["airteltigo 3gb", order(3000, "AT")],
    ["ishare 3gb", order(3000, "AT-iShare")],
    ["bigtime 3gb", order(3000, "AT-BigTime")],
    ["5gb 0551234567", order(5000, null, "0551234567")],
    ["0551234567 5gb", order(5000, null, "0551234567")],
    ["5gb +233551234567", order(5000, null, "0551234567")],
    ["5gb 055 123 4567", order(5000, null, "0551234567")],
    ["5 0551234567", order(5000, null, "0551234567")],
  ])("%s", (text, expected) => expect(parseOrderText(text)).toEqual(expected))

  it.each([
    ["PRICES", "PRICES"], ["prices", "PRICES"], ["menu", "PRICES"], ["price list", "PRICES"],
    ["again", "AGAIN"], ["status", "STATUS"], ["help", "HELP"], ["yes", "YES"], ["Y", "YES"],
  ])("keyword %s", (text, keyword) => expect(parseOrderText(text)).toEqual({ kind: "keyword", keyword }))

  it.each([
    "pls send me 5gig", "buy 2gb for my mum 0551234567", "how much is 10gb", "", "   ",
    "5gb 055123456", // 9 digits: not a valid number, never guessed
    "5gb 0551234567 0241234567", // two numbers
    "0551234567", // a number with no size
    "0", "101", "5.5.5gb",
  ])("unknown: %s", (text) => expect(parseOrderText(text)).toEqual({ kind: "unknown" }))

  it.each([
    "constructor", "__proto__", "valueOf", "toString", "hasOwnProperty",
    "valueof", "tostring", "hasownproperty",
  ])("inherited object property name is unknown: %s", (text) =>
    expect(parseOrderText(text)).toEqual({ kind: "unknown" }))

  it("ignores case, surrounding spaces and trailing punctuation", () =>
    expect(parseOrderText("  5GB.  ")).toEqual(order(5000)))
})

describe("extractGhanaNumbers", () => {
  it("finds local, 233 and +233 forms with spaces or dashes", () =>
    expect(extractGhanaNumbers("a 055-123-4567 b +233 24 123 4567 c 233201234567"))
      .toEqual(["0551234567", "0241234567", "0201234567"]))
  it("rejects 9 and 11 digit runs", () =>
    expect(extractGhanaNumbers("055123456 05512345678")).toEqual([]))
})

describe("parseOrderText airtime", () => {
  const air = (amountGhs: number, networkHint: any = null, recipient: string | null = null) =>
    ({ kind: "order", service: "airtime", amountGhs, networkHint, recipient })
  it.each([
    ["airtime 10", air(10)], ["10 airtime", air(10)], ["airtime ghs10", air(10)], ["airtime GHS 10", air(10)],
    ["airtime 10 cedis", air(10)], ["airtime 10.50", air(10.5)], ["credit 5", air(5)], ["topup 20", air(20)], ["top up 20", air(20)],
    ["recharge 5 telecel", air(5, "Telecel")], ["mtn airtime 10", air(10, "MTN")], ["airtime 10 at", air(10, "AT")],
    ["airtime 10 0200000102", air(10, null, "0200000102")],
  ])("airtime: %s", (t, e) => expect(parseOrderText(t)).toEqual(e))
  it.each(["10", "10gb", "10 gigs", "at 10", "mtn 10"])("still data: %s", (t) =>
    expect(parseOrderText(t)).toMatchObject({ kind: "order", service: "data" }))
  it.each(["airtime 10gbs", "airtime 10 gbs", "airtime 10 gigabytes", "airtime 10 megabytes", "airtime 10 bundle", "airtime 10 bundles", "airtime 10 mbs"])(
    "wider data words are not airtime: %s", (t) => expect(parseOrderText(t)).toEqual({ kind: "unknown" }))
  it("bare 10 is still 10GB and bare", () =>
    expect(parseOrderText("10")).toMatchObject({ service: "data", sizeMb: 10000, bare: true }))
  it.each(["airtime 10gb", "airtime 10 data", "airtime", "airtime 10.555", "airtime 10 20", "airtime 10 ishare", "airtime 10 0200000102 0200000103"])
    ("unknown: %s", (t) => expect(parseOrderText(t)).toEqual({ kind: "unknown" }))
})
