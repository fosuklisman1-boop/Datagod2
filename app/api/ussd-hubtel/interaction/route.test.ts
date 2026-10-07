// app/api/ussd-hubtel/interaction/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const SECRET_TEXT = "Confirm AFA: Kwame Mensah GHA-123456789-0"
const h = vi.hoisted(() => ({ router: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/ussd-hubtel/router", () => ({
  hubtelRouter: (...a: any[]) => h.router(...a),
  defaultRouterDeps: () => ({}),
}))

import { POST } from "./route"

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/ussd-hubtel/interaction?secret=s3cret", { method: "POST", body: JSON.stringify(body) })

let prevSecret: string | undefined
beforeEach(() => {
  prevSecret = process.env.HUBTEL_WEBHOOK_SECRET
  process.env.HUBTEL_WEBHOOK_SECRET = "s3cret"
  h.router.mockReset()
})
afterEach(() => { process.env.HUBTEL_WEBHOOK_SECRET = prevSecret })

describe("POST /api/ussd-hubtel/interaction logging", () => {
  it("logs only the reply type and length, never the message text", async () => {
    h.router.mockResolvedValue({ SessionId: "S1", Type: "response", Message: SECRET_TEXT, Label: "x", DataType: "input", FieldType: "text" })
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const res = await POST(req({ Type: "Response", SessionId: "S1", Mobile: "233244123456", Message: "1", Platform: "USSD" }))
    const logged = JSON.stringify(log.mock.calls)
    const replyCall = log.mock.calls.find(c => String(c[0]).includes("Reply"))
    log.mockRestore()
    expect(res.status).toBe(200)
    expect(logged).not.toContain("Kwame")
    expect(logged).not.toContain("GHA-")
    expect(logged).not.toContain("Confirm AFA")
    expect(replyCall?.[1]).toEqual({ type: "response", len: SECRET_TEXT.length })
  })
})
