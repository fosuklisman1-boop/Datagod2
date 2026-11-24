import { describe, it, expect, vi, afterEach } from "vitest"
import { AgentPortalGHProvider } from "@/lib/mtn-providers/agentportalgh-provider"

afterEach(() => vi.unstubAllGlobals())

describe("resendWebhookDelivery", () => {
  it("encodes the id so it cannot change the upstream path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({}) })
    vi.stubGlobal("fetch", fetchMock)
    await new AgentPortalGHProvider().resendWebhookDelivery("../wallet/topup?x=1")
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain("/api/webhooks/deliveries/..%2Fwallet%2Ftopup%3Fx%3D1/resend")
    expect(url).not.toContain("/wallet/topup")
  })
  it("leaves a normal id unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({}) })
    vi.stubGlobal("fetch", fetchMock)
    await new AgentPortalGHProvider().resendWebhookDelivery(42)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/webhooks/deliveries/42/resend")
  })
})
