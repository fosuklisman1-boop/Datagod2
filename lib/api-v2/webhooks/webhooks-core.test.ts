// Release 6 webhooks: signing, the SSRF guard (URL syntax + address ranges + pinned lookup), the request builder and the
// delivery cycle. Pure: no network, no database (the RPC client and the HTTP transport are fakes).
import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import { newSecret, signatureHeader, verifySignature } from "./sign"
import { checkUrlSyntax, isBlockedAddress, resolveSafe, pinnedLookup } from "./url-guard"
import { buildDelivery, snippetOf } from "./send"
import { deliverOne, runWebhookCycle, type Job, type CycleDeps } from "./worker"

describe("sign", () => {
  it("newSecret is whsec_ + 43 base64url characters and differs each call", () => {
    const a = newSecret()
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(newSecret()).not.toBe(a)
  })
  it("signatureHeader is t=<unix>,v1=<hex HMAC-SHA256 of t.body>", () => {
    const secret = "whsec_" + "A".repeat(43)
    const body = '{"a":1}'
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex")
    expect(signatureHeader(secret, body, 1700000000)).toBe(`t=1700000000,v1=${expected}`)
  })
  it("verifySignature accepts a fresh match and refuses a wrong body, wrong secret, old timestamp or junk", () => {
    const s = newSecret()
    const h = signatureHeader(s, "x", 1000)
    expect(verifySignature(s, "x", h, 1100)).toBe(true)
    expect(verifySignature(s, "y", h, 1100)).toBe(false)
    expect(verifySignature(newSecret(), "x", h, 1100)).toBe(false)
    expect(verifySignature(s, "x", h, 1000 + 301)).toBe(false)
    expect(verifySignature(s, "x", "nonsense", 1000)).toBe(false)
  })
})

describe("checkUrlSyntax", () => {
  it.each([
    ["https://hooks.example.com/datagod", "hooks.example.com"],
    ["https://Hooks.Example.com:443/x?y=1", "hooks.example.com"],
  ])("accepts %s", (u, host) => {
    expect(checkUrlSyntax(u)).toMatchObject({ ok: true, host })
  })
  it.each([
    ["http://hooks.example.com/x", "https"],
    ["https://user:pw@hooks.example.com/x", "credentials"],
    ["https://hooks.example.com:8443/x", "port"],
    ["https://10.0.0.5/x", "IP"],
    ["https://[::1]/x", "IP"],
    ["https://2130706433/x", "IP"],
    ["https://0x7f.0.0.1/x", "IP"],
    ["https://localhost/x", "allowed"],
    ["https://printer.local/x", "allowed"],
    ["https://db.internal/x", "allowed"],
    ["https://intranet/x", "allowed"],
    ["https://hooks.example.com/x#frag", "fragment"],
    ["not a url", "valid"],
    ["https://hooks.example.com/" + "a".repeat(500), "500"],
  ])("refuses %s (%s)", (u, word) => {
    const r = checkUrlSyntax(u)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.toLowerCase()).toContain(word.toLowerCase())
  })
  it("refuses non-strings", () => {
    expect(checkUrlSyntax(42 as unknown as string).ok).toBe(false)
  })
})

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1",
    "192.0.2.5", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
    "::ffff:a00:1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "2002:a00:1::1", "::127.0.0.1", "garbage", "",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true))
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4009:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  )
})

describe("resolveSafe", () => {
  const lookup = (addrs: { address: string; family: number }[]) => async () => addrs
  it("returns the first address when every address is public", async () => {
    expect(await resolveSafe("h.example.com", lookup([{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1", family: 6 }]))).toEqual({
      ok: true,
      address: "8.8.8.8",
      family: 4,
    })
  })
  it("refuses when ANY address is private (mixed public + private answer)", async () => {
    const r = await resolveSafe("h.example.com", lookup([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]))
    expect(r).toMatchObject({ ok: false })
  })
  it("refuses an empty answer and a lookup error", async () => {
    expect((await resolveSafe("h.example.com", lookup([]))).ok).toBe(false)
    expect((await resolveSafe("h.example.com", async () => { throw new Error("ENOTFOUND") })).ok).toBe(false)
  })
})

describe("pinnedLookup", () => {
  it("always answers the vetted address, in both callback shapes", () => {
    const f = pinnedLookup("8.8.8.8", 4)
    let single: unknown[] = []
    f("evil.example.com", {}, (...a: unknown[]) => (single = a))
    expect(single).toEqual([null, "8.8.8.8", 4])
    let all: unknown[] = []
    f("evil.example.com", { all: true }, (...a: unknown[]) => (all = a))
    expect(all).toEqual([null, [{ address: "8.8.8.8", family: 4 }]])
  })
})

describe("buildDelivery and snippetOf", () => {
  it("signs exactly the body it sends and names the event", () => {
    const secret = newSecret()
    const d = buildDelivery({ id: "evt_" + "a".repeat(24), type: "order.updated", payload: { id: "evt_x", data: { b: 2 } }, secret }, 1700000000)
    expect(d.body).toBe(JSON.stringify({ id: "evt_x", data: { b: 2 } }))
    expect(d.headers["Content-Type"]).toBe("application/json")
    expect(d.headers["User-Agent"]).toBe("Datagod-Webhooks/1")
    expect(d.headers["Datagod-Event-Id"]).toBe("evt_" + "a".repeat(24))
    expect(d.headers["Datagod-Event-Type"]).toBe("order.updated")
    expect(verifySignature(secret, d.body, d.headers["Datagod-Signature"], 1700000000)).toBe(true)
  })
  it("snippetOf keeps 200 printable characters", () => {
    expect(snippetOf("ok\u0000\u001b[31m" + "x".repeat(300))).toHaveLength(200)
    expect(snippetOf("ok\u0000\n")).toBe("ok")
    expect(snippetOf(undefined)).toBeNull()
  })
})

// ---------- the cycle ----------

function fakeClient(jobs: Job[], opts: { scan?: number; scanError?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args })
        if (fn === "api_v2_webhook_scan") return opts.scanError ? { data: null, error: { message: "x" } } : { data: opts.scan ?? 0, error: null }
        if (fn === "api_v2_webhook_claim") return { data: jobs, error: null }
        if (fn === "api_v2_webhook_record") return { data: { recorded: true, state: args.p_ok ? "delivered" : "pending" }, error: null }
        return { data: null, error: { message: "unknown fn" } }
      },
    },
  }
}
const job = (over: Partial<Job> = {}): Job => ({
  id: "evt_" + "b".repeat(24),
  user_id: "u1",
  type: "order.updated",
  payload: { id: "evt_x" },
  attempt: 1,
  url: "https://hooks.example.com/x",
  secret: "whsec_" + "C".repeat(43),
  ...over,
})
const deps = (over: Partial<CycleDeps> = {}): CycleDeps => ({
  now: () => new Date("2026-11-26T00:00:00Z"),
  resolve: async () => [{ address: "8.8.8.8", family: 4 }],
  post: async () => ({ status: 200, body: "ok" }),
  ...over,
})

describe("deliverOne", () => {
  it("2xx records ok with the code and a snippet; the transport gets the pinned address and the signed body", async () => {
    const { client, calls } = fakeClient([])
    let seen: Record<string, unknown> = {}
    const r = await deliverOne(client, job(), deps({ post: async (p) => ((seen = p as unknown as Record<string, unknown>), { status: 204, body: "" }) }))
    expect(r.ok).toBe(true)
    expect(seen).toMatchObject({ url: "https://hooks.example.com/x", address: "8.8.8.8", family: 4, timeoutMs: 10_000 })
    const rec = calls.find((c) => c.fn === "api_v2_webhook_record")!
    expect(rec.args).toMatchObject({ p_event: job().id, p_attempt: 1, p_ok: true, p_code: 204 })
  })
  it("a redirect, a 500, a blocked address, a bad url, a DNS failure and a timeout all record a failure without throwing", async () => {
    const cases: [Partial<CycleDeps>, Partial<Job>, RegExp][] = [
      [{ post: async () => ({ status: 302, body: "" }) }, {}, /redirect/i],
      [{ post: async () => ({ status: 500, body: "boom" }) }, {}, /HTTP 500/],
      [{ resolve: async () => [{ address: "10.0.0.1", family: 4 }] }, {}, /private/i],
      [{}, { url: "http://hooks.example.com/x" }, /https/i],
      [{ resolve: async () => { throw new Error("ENOTFOUND secret-host") } }, {}, /DNS/i],
      [{ post: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e } }, {}, /timed out/i],
      [{ post: async () => { throw new Error("ECONNREFUSED 8.8.8.8:443") } }, {}, /connection failed/i],
    ]
    for (const [d, j, re] of cases) {
      const { client, calls } = fakeClient([])
      const r = await deliverOne(client, job(j), deps(d))
      expect(r.ok).toBe(false)
      const rec = calls.find((c) => c.fn === "api_v2_webhook_record")!
      expect(rec.args.p_ok).toBe(false)
      expect(String(rec.args.p_error)).toMatch(re)
      expect(String(rec.args.p_error)).not.toMatch(/secret-host|8\.8\.8\.8/)
    }
  })
})

describe("runWebhookCycle", () => {
  it("scans, claims, delivers each job at most 10 at a time, and reports counts", async () => {
    const jobs = Array.from({ length: 23 }, (_, i) => job({ id: "evt_" + String(i).padStart(24, "0") }))
    const { client, calls } = fakeClient(jobs, { scan: 4 })
    let live = 0
    let peak = 0
    const out = await runWebhookCycle(client, deps({
      post: async () => {
        live++
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 2))
        live--
        return { status: 200, body: "" }
      },
    }))
    expect(out).toEqual({ scanned: 4, sent: 23, delivered: 23, failed: 0 })
    expect(peak).toBeLessThanOrEqual(10)
    expect(calls.filter((c) => c.fn === "api_v2_webhook_record")).toHaveLength(23)
    expect(calls[0].fn).toBe("api_v2_webhook_scan")
  })
  it("a scan error still delivers what is already queued", async () => {
    const { client } = fakeClient([job()], { scanError: true })
    expect(await runWebhookCycle(client, deps())).toMatchObject({ scanned: 0, sent: 1, delivered: 1 })
  })
})
