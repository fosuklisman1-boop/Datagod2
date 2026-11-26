// Release 6 admin webhooks switch (lib behind /api/admin/api-v2/webhook-settings). Fake RPC client.
import { describe, it, expect } from "vitest"
import { getWebhookSettingsAdmin, saveWebhookSettings } from "./webhooks"

function client(answer: { data?: unknown; error?: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return { data: answer.data ?? null, error: answer.error ?? null }
    },
  }
}
const ADMIN = "22222222-2222-4222-8222-222222222222"

describe("getWebhookSettingsAdmin", () => {
  it("maps the switch, endpoint count and today's counts", async () => {
    const c = client({ data: { enabled: true, updated_at: "2026-11-26T00:00:00Z", endpoints: 3, today: { pending: 1, delivered: 9, failed: 2 } } })
    const r = await getWebhookSettingsAdmin(c as never, new Date("2026-11-26T08:00:00Z"))
    expect(r).toEqual({ status: 200, body: { enabled: true, updatedAt: "2026-11-26T00:00:00Z", endpoints: 3, today: { pending: 1, delivered: 9, failed: 2 } } })
    expect(c.calls[0]).toEqual({ fn: "api_v2_webhook_settings_get", args: { p_now: "2026-11-26T08:00:00.000Z" } })
  })
  it("a database failure is a 500 without the raw message", async () => {
    const r = await getWebhookSettingsAdmin(client({ error: { message: "secret detail" } }) as never, new Date())
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain("secret detail")
  })
})

describe("saveWebhookSettings", () => {
  it("needs a real admin id (the cron path has none)", async () => {
    const c = client({ data: { changed: true } })
    expect((await saveWebhookSettings(c as never, { enabled: true, actorId: undefined })).status).toBe(403)
    expect(c.calls).toHaveLength(0)
  })
  it("refuses anything but a boolean", async () => {
    expect((await saveWebhookSettings(client({}) as never, { enabled: "yes", actorId: ADMIN })).status).toBe(400)
  })
  it("passes the value and the actor and reports changed", async () => {
    const c = client({ data: { changed: true, enabled: false } })
    expect(await saveWebhookSettings(c as never, { enabled: false, actorId: ADMIN })).toEqual({ status: 200, body: { ok: true, changed: true } })
    expect(c.calls[0]).toEqual({ fn: "api_v2_webhook_settings_set", args: { p_enabled: false, p_actor: ADMIN } })
  })
})
