import { describe, it, expect } from "vitest"
import {
  parseLogsQuery,
  parseOrdersQuery,
  localPhone,
  parseThreshold,
  ordersCsv,
  csvCell,
  readUsage,
  readLogs,
  readOrders,
  getBalanceAlert,
  setBalanceAlert,
  ORDER_PRODUCTS,
} from "./dev-dashboard"

const KEY = "11111111-2222-3333-4444-555555555555"
const q = (s: string) => new URLSearchParams(s)

function fakeRpc(result: { data?: unknown; error?: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args })
        return { data: result.data ?? null, error: result.error ?? null }
      },
    },
  }
}

describe("parseLogsQuery", () => {
  it("takes known filters, day dates as whole UTC days, a cursor and a limit", () => {
    const r = parseLogsQuery(q(`key=${KEY}&env=live&status=client&endpoint=/api/v2/airtime&from=2026-11-01&to=2026-11-20&before=2026-11-20T10:00:00.000Z|${KEY}&limit=20`))
    expect(r).toEqual({
      ok: true,
      value: {
        filters: { key: KEY, env: "live", status: "client", endpoint: "/api/v2/airtime", from: "2026-11-01T00:00:00.000Z", to: "2026-11-20T23:59:59.999Z" },
        beforeAt: "2026-11-20T10:00:00.000Z",
        beforeId: KEY,
        limit: 20,
      },
    })
  })
  it("keeps the cursor time exactly as the database wrote it (microseconds), so no row is skipped", () => {
    const at = "2026-11-20T10:00:00.123456+00:00"
    const r = parseLogsQuery(q(`before=${encodeURIComponent(at)}|${KEY}`))
    expect(r.ok && r.value.beforeAt).toBe(at)
    const o = parseOrdersQuery(q(`before=${encodeURIComponent(at)}|data:abc`))
    expect(o.ok && o.value.beforeAt).toBe(at)
    expect(parseLogsQuery(q(`before=${encodeURIComponent("Tue Nov 20 2026")}|${KEY}`)).ok).toBe(false)
  })
  it("a From date alone covers that day plus the next 30 (never silently the last 31 days)", () => {
    const r = parseLogsQuery(q("from=2026-08-01"))
    expect(r.ok && r.value.filters).toEqual({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" })
    const o = parseOrdersQuery(q("from=2026-08-01"))
    expect(o.ok && o.value.filters).toEqual({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" })
  })
  it("drops unknown values instead of passing them on", () => {
    const r = parseLogsQuery(q("env=prod&status=weird&endpoint=/etc/passwd&limit=9999"))
    expect(r).toEqual({ ok: true, value: { filters: {}, beforeAt: null, beforeId: null, limit: 50 } })
  })
  it("refuses a bad key, a bad date, a reversed or too-wide range and a bad cursor", () => {
    expect(parseLogsQuery(q("key=abc")).ok).toBe(false)
    expect(parseLogsQuery(q("from=2026-13-01")).ok).toBe(false)
    expect(parseLogsQuery(q("from=2026-11-20&to=2026-11-01")).ok).toBe(false)
    expect(parseLogsQuery(q("from=2026-09-01&to=2026-11-01")).ok).toBe(false)
    expect(parseLogsQuery(q("before=yesterday|x")).ok).toBe(false)
  })
})

describe("localPhone", () => {
  it("reads 0XXXXXXXXX, 233XXXXXXXXX and +233 forms with spaces", () => {
    expect(localPhone("024 123 4567")).toBe("0241234567")
    expect(localPhone("233241234567")).toBe("0241234567")
    expect(localPhone("+233 24 123 4567")).toBe("0241234567")
    expect(localPhone("REF-0241234567")).toBeNull()
    expect(localPhone("12345")).toBeNull()
  })
})

describe("parseOrdersQuery", () => {
  it("a phone in the search box searches the recipient; anything else is a reference", () => {
    expect(parseOrdersQuery(q("q=%2B233241234567")).ok && (parseOrdersQuery(q("q=%2B233241234567")) as any).value.filters).toEqual({ recipient: "0241234567" })
    expect((parseOrdersQuery(q("q=  ORDER-77  ")) as any).value.filters).toEqual({ reference: "ORDER-77" })
  })
  it("keeps known product and status, a cursor and the CSV limit", () => {
    const r = parseOrdersQuery(q("product=airtime&status=failed&from=2026-11-01&to=2026-11-02&before=2026-11-02T00:00:00.000Z|data:abc"), { csv: true })
    expect(r).toEqual({
      ok: true,
      value: {
        filters: { product: "airtime", status: "failed", from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T23:59:59.999Z" },
        beforeAt: "2026-11-02T00:00:00.000Z",
        beforeKey: "data:abc",
        limit: 5000,
      },
    })
    expect((parseOrdersQuery(q("product=sms&status=lost")) as any).value.filters).toEqual({})
  })
  it("refuses an over-long search and a range wider than 31 days", () => {
    expect(parseOrdersQuery(q("q=" + "x".repeat(101))).ok).toBe(false)
    expect(parseOrdersQuery(q("from=2026-10-01&to=2026-11-15")).ok).toBe(false)
  })
  it("lists every product the SQL knows", () => {
    expect([...ORDER_PRODUCTS]).toEqual(["data", "airtime", "bill", "bundle", "results", "afa"])
  })
})

describe("parseThreshold", () => {
  it("accepts 0.01..100000 with at most 2 decimals; null removes", () => {
    expect(parseThreshold(null)).toEqual({ ok: true, value: null })
    expect(parseThreshold("")).toEqual({ ok: true, value: null })
    expect(parseThreshold("19.99")).toEqual({ ok: true, value: 19.99 })
    expect(parseThreshold(50)).toEqual({ ok: true, value: 50 })
    for (const bad of [0, -1, 100000.01, "1.005", "abc", NaN, Infinity, true]) expect(parseThreshold(bad).ok, String(bad)).toBe(false)
  })
})

describe("CSV", () => {
  it("guards formulas and quotes separators", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)")
    expect(csvCell("-5")).toBe("'-5")
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
    expect(csvCell(null)).toBe("")
  })
  it("writes a BOM, a header in words and CRLF rows with amounts to 2 places", () => {
    const out = ordersCsv([
      { product: "data", reference: "=cmd", created_at: "2026-11-25T10:00:00Z", recipient: "0241234567", amount: 6.5, item: "MTN 1 GB", status: "completed" },
    ])
    expect(out.charCodeAt(0)).toBe(0xfeff)
    const lines = out.slice(1).split("\r\n")
    expect(lines[0]).toBe("Date (GMT),Product,Reference,Recipient,Item,Amount (GHS),Status")
    expect(lines[1]).toBe("2026-11-25 10:00,Data,'=cmd,0241234567,MTN 1 GB,6.50,completed")
  })
})

describe("RPC wrappers", () => {
  it("readUsage passes only the session user and a known day count", async () => {
    const f = fakeRpc({ data: { days: 7 } })
    expect(await readUsage(f.client, "u1", 99, "prod")).toEqual({ ok: true, value: { days: 7 } })
    expect(f.calls[0]).toEqual({ fn: "api_v2_dev_usage", args: { p_user: "u1", p_days: 7, p_env: null } })
  })
  it("readLogs and readOrders pass parsed filters; an error reads as unavailable", async () => {
    const f = fakeRpc({ data: [{ id: "x" }] })
    await readLogs(f.client, "u1", { filters: { env: "live" }, beforeAt: null, beforeId: null, limit: 50 })
    expect(f.calls[0]).toEqual({ fn: "api_v2_dev_logs", args: { p_user: "u1", p_filters: { env: "live" }, p_before_at: null, p_before_id: null, p_limit: 50 } })
    await readOrders(f.client, "u1", { filters: {}, beforeAt: null, beforeKey: null, limit: 50 })
    expect(f.calls[1].fn).toBe("api_v2_dev_orders")
    const bad = fakeRpc({ error: { message: "boom" } })
    expect(await readLogs(bad.client, "u1", { filters: {}, beforeAt: null, beforeId: null, limit: 50 })).toEqual({ ok: false })
  })
  it("balance alert get/set map to their functions; a refused threshold never reaches the database", async () => {
    const f = fakeRpc({ data: { alert: null, balance: 12.5 } })
    expect(await getBalanceAlert(f.client, "u1")).toEqual({ status: 200, body: { alert: null, balance: 12.5 } })
    const s = fakeRpc({ data: { threshold: 20 } })
    expect(await setBalanceAlert(s.client, "u1", "abc")).toMatchObject({ status: 400 })
    expect(s.calls).toHaveLength(0)
    expect(await setBalanceAlert(s.client, "u1", "20")).toEqual({ status: 200, body: { threshold: 20 } })
    expect(s.calls[0]).toEqual({ fn: "api_v2_set_balance_alert", args: { p_user: "u1", p_threshold: 20 } })
    const e = fakeRpc({ error: { message: "x" } })
    expect(await setBalanceAlert(e.client, "u1", null)).toMatchObject({ status: 503 })
  })
})
