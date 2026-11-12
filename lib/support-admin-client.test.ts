import { describe, expect, it } from "vitest"
import {
  filterLegacy,
  isPlausibleEmail,
  legacyStatusCounts,
  mailtoHref,
  mergeThreadList,
  normalizeWhatsappDigits,
  previewText,
  safeAttachmentUrl,
  shouldApplyResponse,
  supplierBadgeModel,
  telHref,
  threadMatchesSearch,
  whatsappHref,
  type AdminThreadListItem,
  type LegacyListItem,
} from "./support-admin-client"

describe("contact links", () => {
  it("normalises a local number to 233 form", () => {
    expect(normalizeWhatsappDigits("0241234567")).toBe("233241234567")
  })
  it("strips a leading plus", () => {
    expect(normalizeWhatsappDigits("+233241234567")).toBe("233241234567")
  })
  it("rejects values that fail the strict phone check", () => {
    expect(normalizeWhatsappDigits("024123456")).toBeNull()
    expect(normalizeWhatsappDigits("0241234567 ")).toBeNull()
    expect(normalizeWhatsappDigits("233241234567")).toBeNull()
    expect(normalizeWhatsappDigits("0141234567")).toBeNull()
    expect(normalizeWhatsappDigits("0241234567/../x")).toBeNull()
    expect(normalizeWhatsappDigits(null)).toBeNull()
  })
  it("builds wa.me, tel and mailto links only for valid values", () => {
    expect(whatsappHref("0241234567")).toBe("https://wa.me/233241234567")
    expect(whatsappHref("bad")).toBeNull()
    expect(telHref("+233241234567")).toBe("tel:+233241234567")
    expect(telHref("javascript:alert(1)")).toBeNull()
    expect(mailtoHref("a@b.com")).toBe("mailto:a@b.com")
    expect(mailtoHref("a@@b.com")).toBeNull()
    expect(mailtoHref("a b@c.com")).toBeNull()
    expect(mailtoHref("nope")).toBeNull()
    expect(mailtoHref(null)).toBeNull()
  })
  it("checks email shape", () => {
    expect(isPlausibleEmail("x@y")).toBe(true)
    expect(isPlausibleEmail("x@y@z")).toBe(false)
    expect(isPlausibleEmail("x@y\n")).toBe(false)
  })
  it("rejects characters that could inject mailto parameters", () => {
    expect(isPlausibleEmail("a@b.com?bcc=x")).toBe(false)
    expect(isPlausibleEmail("a@b.com&x=1")).toBe(false)
    expect(isPlausibleEmail("a#b@c.com")).toBe(false)
    expect(isPlausibleEmail("a%40b@c.com")).toBe(false)
    expect(isPlausibleEmail("a,b@c.com")).toBe(false)
    expect(isPlausibleEmail("a<b@c.com")).toBe(false)
    expect(isPlausibleEmail("a>b@c.com")).toBe(false)
    expect(isPlausibleEmail('a"b@c.com')).toBe(false)
    expect(isPlausibleEmail("a'b@c.com")).toBe(false)
    expect(isPlausibleEmail("a\u0000b@c.com")).toBe(false)
    expect(isPlausibleEmail("first.last+tag@example.co.uk")).toBe(true)
    expect(mailtoHref("a@b.com?bcc=x")).toBeNull()
  })
})

describe("shouldApplyResponse", () => {
  it("applies only a newer response for the open thread", () => {
    expect(shouldApplyResponse(2, 1, "t1", "t1")).toBe(true)
    expect(shouldApplyResponse(1, 2, "t1", "t1")).toBe(false)
    expect(shouldApplyResponse(2, 2, "t1", "t1")).toBe(false)
    expect(shouldApplyResponse(3, 1, "t1", "t2")).toBe(false)
    expect(shouldApplyResponse(3, 1, "t1", null)).toBe(false)
  })
  it("a load started after a poll is not discarded in favour of the poll", () => {
    // poll takes seq 1, reply reload takes seq 2; reload lands first, then the poll
    let last = 0
    expect(shouldApplyResponse(2, last, "t1", "t1")).toBe(true)
    last = 2
    expect(shouldApplyResponse(1, last, "t1", "t1")).toBe(false)
  })
})

describe("safeAttachmentUrl", () => {
  it("allows only https urls", () => {
    expect(safeAttachmentUrl("https://x.supabase.co/a.png?token=1")).toBe("https://x.supabase.co/a.png?token=1")
    expect(safeAttachmentUrl("http://x.com/a.png")).toBeNull()
    expect(safeAttachmentUrl("javascript:alert(1)")).toBeNull()
    expect(safeAttachmentUrl("data:image/png;base64,AAAA")).toBeNull()
    expect(safeAttachmentUrl(null)).toBeNull()
    expect(safeAttachmentUrl(undefined)).toBeNull()
  })
})

const thread = (over: Partial<AdminThreadListItem> = {}): AdminThreadListItem => ({
  id: "t1",
  subject: "Issue with order DG-1234",
  phone_number: "0241234567",
  unread_count: 2,
  status: "open",
  last_message_at: "2026-11-12T10:00:00Z",
  user: { first_name: "Ama", last_name: "Mensah", email: "ama@example.com", phone_number: null },
  order: { reference: "ORD-9X", beneficiary: "0551112222" } as AdminThreadListItem["order"],
  last_message: { body: "hello", sender_role: "user", created_at: "2026-11-12T10:00:00Z" },
  ...over,
})

describe("threadMatchesSearch", () => {
  it("matches name, email, subject, phone and order reference case-insensitively", () => {
    const t = thread()
    expect(threadMatchesSearch(t, "ama mensah")).toBe(true)
    expect(threadMatchesSearch(t, "AMA@EXAMPLE")).toBe(true)
    expect(threadMatchesSearch(t, "dg-1234")).toBe(true)
    expect(threadMatchesSearch(t, "024123")).toBe(true)
    expect(threadMatchesSearch(t, "ord-9x")).toBe(true)
  })
  it("returns true for an empty query and false for no match", () => {
    expect(threadMatchesSearch(thread(), "  ")).toBe(true)
    expect(threadMatchesSearch(thread(), "zzz")).toBe(false)
  })
  it("copes with null user fields and no order", () => {
    const t = thread({ user: { first_name: null, last_name: null, email: null, phone_number: null }, order: null })
    expect(threadMatchesSearch(t, "dg-1234")).toBe(true)
    expect(threadMatchesSearch(t, "ama")).toBe(false)
  })
})

describe("previewText", () => {
  it("prefixes admin messages with You: ", () => {
    expect(previewText({ body: "ok", sender_role: "admin" })).toBe("You: ok")
    expect(previewText({ body: "ok", sender_role: "user" })).toBe("ok")
  })
  it("truncates long bodies with an ellipsis and collapses whitespace", () => {
    const out = previewText({ body: "a".repeat(200), sender_role: "user" }, 50)
    expect(out.length).toBe(50)
    expect(out.endsWith("…")).toBe(true)
    expect(previewText({ body: "a\n\n b", sender_role: "user" })).toBe("a b")
  })
  it("returns empty text for no message", () => {
    expect(previewText(null)).toBe("")
  })
})

describe("mergeThreadList", () => {
  it("keeps a locally zeroed badge while the server still reports unread", () => {
    const r = mergeThreadList([thread({ unread_count: 0 })], [thread({ unread_count: 2 })], new Set(["t1"]))
    expect(r.threads[0].unread_count).toBe(0)
    expect(r.zeroed.has("t1")).toBe(true)
  })
  it("releases the override once the server agrees", () => {
    const r = mergeThreadList([], [thread({ unread_count: 0 })], new Set(["t1"]))
    expect(r.threads[0].unread_count).toBe(0)
    expect(r.zeroed.has("t1")).toBe(false)
  })
  it("passes other rows through untouched and drops overrides for vanished rows", () => {
    const r = mergeThreadList([], [thread({ id: "t2", unread_count: 3 })], new Set(["t1"]))
    expect(r.threads[0].unread_count).toBe(3)
    expect(r.zeroed.size).toBe(0)
  })
})

const legacy = (over: Partial<LegacyListItem> = {}): LegacyListItem => ({
  id: "c1",
  title: "Data not received",
  description: "Nothing arrived",
  status: "pending",
  created_at: "2026-11-12T12:00:00",
  user: { first_name: "Kofi", last_name: "Boateng", email: "kofi@example.com" },
  order: { reference: "REF-77", beneficiary: "0200000000", network: "MTN", size: "2GB", shop_name: null } as LegacyListItem["order"],
  ...over,
})

describe("legacy filters", () => {
  const now = new Date(2026, 10, 12, 15, 0, 0)
  const items = [
    legacy({ id: "today", created_at: new Date(2026, 10, 12, 9, 0).toISOString() }),
    legacy({ id: "yest", status: "resolved", created_at: new Date(2026, 10, 11, 9, 0).toISOString() }),
    legacy({ id: "old", status: "rejected", created_at: new Date(2026, 10, 1, 9, 0).toISOString() }),
  ]
  const base = { search: "", status: "all", preset: "all" as const, from: "", to: "" }

  it("counts statuses", () => {
    expect(legacyStatusCounts(items)).toEqual({ all: 3, pending: 1, in_review: 0, resolved: 1, rejected: 1 })
  })
  it("filters by status and search", () => {
    expect(filterLegacy(items, { ...base, status: "resolved" }, now).map((c) => c.id)).toEqual(["yest"])
    expect(filterLegacy(items, { ...base, search: "ref-77" }, now)).toHaveLength(3)
    expect(filterLegacy(items, { ...base, search: "kofi" }, now)).toHaveLength(3)
    expect(filterLegacy(items, { ...base, search: "nomatch" }, now)).toHaveLength(0)
  })
  it("applies date presets", () => {
    expect(filterLegacy(items, { ...base, preset: "today" }, now).map((c) => c.id)).toEqual(["today"])
    expect(filterLegacy(items, { ...base, preset: "yesterday" }, now).map((c) => c.id)).toEqual(["yest"])
    expect(filterLegacy(items, { ...base, preset: "7d" }, now).map((c) => c.id)).toEqual(["today", "yest"])
  })
  it("applies a custom inclusive range", () => {
    const out = filterLegacy(items, { ...base, preset: "custom", from: "2026-11-01", to: "2026-11-11" }, now)
    expect(out.map((c) => c.id)).toEqual(["yest", "old"])
  })
})

describe("supplierBadgeModel", () => {
  it("shows N/A for null", () => {
    expect(supplierBadgeModel(null).label).toBe("N/A")
  })
  it("shows Manual for manual", () => {
    expect(supplierBadgeModel({ kind: "manual" }).label).toBe("Manual")
  })
  it("shows the provider label", () => {
    expect(supplierBadgeModel({ kind: "supplier", provider: "datakazina", attemptedOnly: false }).label).toBe("DataKazina")
  })
  it("prefixes Last tried: when attempted only", () => {
    expect(supplierBadgeModel({ kind: "supplier", provider: "datakazina", attemptedOnly: true }).label).toBe(
      "Last tried: DataKazina",
    )
  })
})
