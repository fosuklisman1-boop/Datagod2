// Release 6 developer webhook tools (lib behind /api/user/v2-dashboard/webhook*). Fake RPC client; no network.
import { describe, it, expect } from "vitest"
import { deleteWebhook, getWebhook, listDeliveries, resendDelivery, revealSecret, rotateSecret, saveWebhook, sendTestEvent, type DevDeps } from "./dev"

type Call = { fn: string; args: Record<string, unknown> }
function client(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: Call[] = []
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (!(fn in answers)) return { data: null, error: { message: "no" } }
      const a = answers[fn]
      return { data: typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : a, error: null }
    },
  }
}
const USER = "11111111-1111-4111-8111-111111111111"
const SECRET = "whsec_" + "S".repeat(43)
const deps = (over: Partial<DevDeps> = {}): DevDeps => ({
  newSecret: () => SECRET,
  resolve: async () => [{ address: "8.8.8.8", family: 4 }],
  now: () => new Date("2026-11-26T00:00:00Z"),
  post: async () => ({ status: 200, body: "ok" }),
  ...over,
})
const endpoint = { enabled_globally: true, endpoint: { url: "https://h.example.com/x", enabled: true, secret_hint: "SSSS" } }

describe("getWebhook", () => {
  it("returns the stored endpoint (never a secret)", async () => {
    const c = client({ api_v2_webhook_get: endpoint })
    expect(await getWebhook(c, USER)).toEqual({ status: 200, body: endpoint })
    expect(c.calls[0].args).toEqual({ p_user: USER })
  })
  it("503 when the database fails", async () => {
    expect((await getWebhook(client({}), USER)).status).toBe(503)
  })
})

describe("saveWebhook", () => {
  it("refuses a bad URL or a private host before touching the database", async () => {
    const c = client({ api_v2_webhook_set_endpoint: { created: true, ...endpoint } })
    const r1 = await saveWebhook(c, USER, { url: "http://h.example.com/x" }, deps())
    expect(r1.status).toBe(400)
    const r2 = await saveWebhook(c, USER, { url: "https://h.example.com/x" }, deps({ resolve: async () => [{ address: "10.0.0.1", family: 4 }] }))
    expect(r2.status).toBe(400)
    expect(JSON.stringify(r2.body)).toMatch(/private/i)
    expect(c.calls).toHaveLength(0)
  })
  it("refuses a non-boolean enabled", async () => {
    expect((await saveWebhook(client({}), USER, { url: "https://h.example.com/x", enabled: "yes" }, deps())).status).toBe(400)
  })
  it("creates with a fresh secret and shows that secret once; an edit never returns a secret", async () => {
    const c = client({ api_v2_webhook_set_endpoint: (a: Record<string, unknown>) => ({ ...endpoint, created: a.p_url === "https://h.example.com/x" }) })
    const created = await saveWebhook(c, USER, { url: " https://h.example.com/x " }, deps())
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ created: true, secret: SECRET })
    expect(c.calls[0].args).toEqual({ p_user: USER, p_url: "https://h.example.com/x", p_enabled: null, p_new_secret: SECRET })
    const edited = await saveWebhook(c, USER, { url: "https://h.example.com/y", enabled: false }, deps())
    expect(edited.body).not.toHaveProperty("secret")
    expect(c.calls[1].args.p_enabled).toBe(false)
  })
})

describe("secret, delete", () => {
  it("reveal returns the secret or 404", async () => {
    expect(await revealSecret(client({ api_v2_webhook_reveal: SECRET }), USER)).toEqual({ status: 200, body: { secret: SECRET } })
    expect((await revealSecret(client({ api_v2_webhook_reveal: null }), USER)).status).toBe(404)
  })
  it("rotate stores a new secret and returns it once; 404 without an endpoint", async () => {
    const c = client({ api_v2_webhook_rotate_secret: endpoint })
    const r = await rotateSecret(c, USER, deps())
    expect(r.body).toMatchObject({ secret: SECRET, endpoint: endpoint.endpoint })
    expect(c.calls[0].args).toEqual({ p_user: USER, p_new_secret: SECRET })
    expect((await rotateSecret(client({ api_v2_webhook_rotate_secret: { error: "no_endpoint" } }), USER, deps())).status).toBe(404)
  })
  it("delete passes through removed", async () => {
    expect(await deleteWebhook(client({ api_v2_webhook_delete_endpoint: { removed: true } }), USER)).toEqual({ status: 200, body: { removed: true } })
  })
})

describe("sendTestEvent", () => {
  const job = { id: "evt_" + "a".repeat(24), user_id: USER, type: "webhook.test", payload: { id: "x" }, attempt: 1, url: "https://h.example.com/x", secret: SECRET }
  it("enqueues, claims that event, sends it and reports the outcome", async () => {
    const c = client({ api_v2_webhook_enqueue_test: { id: job.id }, api_v2_webhook_claim_one: job, api_v2_webhook_record: { state: "delivered" } })
    const r = await sendTestEvent(c, USER, deps({ post: async () => ({ status: 202, body: "" }) }))
    expect(r).toMatchObject({ status: 200, body: { ok: true, code: 202, event_id: job.id } })
    expect(c.calls.map((x) => x.fn)).toEqual(["api_v2_webhook_enqueue_test", "api_v2_webhook_claim_one", "api_v2_webhook_record"])
    expect(c.calls[1].args).toMatchObject({ p_user: USER, p_event: job.id })
  })
  it("a failed delivery is still 200 with ok false and the reason", async () => {
    const c = client({ api_v2_webhook_enqueue_test: { id: job.id }, api_v2_webhook_claim_one: job, api_v2_webhook_record: { state: "failed" } })
    const r = await sendTestEvent(c, USER, deps({ post: async () => ({ status: 500, body: "" }) }))
    expect(r.body).toMatchObject({ ok: false, code: 500, error: "HTTP 500" })
  })
  it("409 while webhooks are off, 404 without an endpoint", async () => {
    expect((await sendTestEvent(client({ api_v2_webhook_enqueue_test: { error: "disabled" } }), USER, deps())).status).toBe(409)
    expect((await sendTestEvent(client({ api_v2_webhook_enqueue_test: { error: "no_endpoint" } }), USER, deps())).status).toBe(404)
  })
})

describe("listDeliveries", () => {
  const row = (i: number) => ({ id: "evt_" + String(i).padStart(24, "0"), created_at: `2026-11-25T10:00:0${i}.123456+00:00` })
  it("first page without a cursor; next cursor is the last row when the page is full", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(i % 10))
    const c = client({ api_v2_webhook_deliveries: rows })
    const r = await listDeliveries(c, USER, null)
    expect(c.calls[0].args).toEqual({ p_user: USER, p_before_at: null, p_before_id: null, p_limit: 25 })
    expect((r.body as { next: string }).next).toBe(`${rows[24].created_at}|${rows[24].id}`)
  })
  it("passes a cursor through unchanged and gives no next on a short page", async () => {
    const c = client({ api_v2_webhook_deliveries: [row(1)] })
    const cur = `2026-11-25T10:00:01.123456+00:00|evt_${"0".repeat(23)}1`
    const r = await listDeliveries(c, USER, cur)
    expect(c.calls[0].args).toMatchObject({ p_before_at: "2026-11-25T10:00:01.123456+00:00", p_before_id: `evt_${"0".repeat(23)}1` })
    expect((r.body as { next: string | null }).next).toBeNull()
  })
  it("400 on a malformed cursor", async () => {
    expect((await listDeliveries(client({}), USER, "garbage")).status).toBe(400)
  })
})

describe("resendDelivery", () => {
  it("validates the id and maps not_found / pending", async () => {
    expect((await resendDelivery(client({}), USER, "evt_bad")).status).toBe(400)
    const id = "evt_" + "c".repeat(24)
    expect((await resendDelivery(client({ api_v2_webhook_resend: { ok: true } }), USER, id)).status).toBe(200)
    expect((await resendDelivery(client({ api_v2_webhook_resend: { error: "not_found" } }), USER, id)).status).toBe(404)
    expect((await resendDelivery(client({ api_v2_webhook_resend: { error: "pending" } }), USER, id)).status).toBe(409)
  })
})
