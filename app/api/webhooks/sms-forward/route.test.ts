import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const ingestMock = vi.fn()
vi.mock("@/lib/momo-claim/ingest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/momo-claim/ingest")>("@/lib/momo-claim/ingest")
  return { ...actual, ingestForwardedSms: (...a: unknown[]) => ingestMock(...a) }
})
const settingsMock = vi.fn()
vi.mock("@/lib/momo-claim/settings", () => ({
  loadMomoClaimSettings: (...a: unknown[]) => settingsMock(...a),
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { tag: "admin-client" } }))

import { POST } from "./route"
import { MomoStoreError } from "@/lib/momo-claim/ingest"

const SECRET = "s3cret-value-for-tests-0123456789"
const SMS = "Payment received for GHS 50.00 from JANE DOE Current Balance GHS 1.00. Transaction ID: 80000000123."
const URL_ = "http://localhost/api/webhooks/sms-forward"

const jsonReq = (body: unknown, headers: Record<string, string> = { "x-sms-forward-secret": SECRET }, url = URL_) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
const formReq = (body: string, headers: Record<string, string> = { "x-sms-forward-secret": SECRET }) =>
  new NextRequest(URL_, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  })

let logSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  vi.clearAllMocks()
  process.env.SMS_FORWARD_SECRET = SECRET
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  ingestMock.mockResolvedValue("stored_pending")
  settingsMock.mockResolvedValue({ enabled: true, senderAllowlist: ["MobileMoney"] })
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})
afterEach(() => {
  delete process.env.SMS_FORWARD_SECRET
  for (const spy of logSpies) {
    const dump = JSON.stringify(spy.mock.calls)
    expect(dump).not.toContain("JANE DOE")
    expect(dump).not.toContain("80000000123")
    spy.mockRestore()
  }
})

const bodyText = async (res: Response) => await res.text()

describe("POST /api/webhooks/sms-forward", () => {
  it("401s every request when the secret env is missing or empty", async () => {
    delete process.env.SMS_FORWARD_SECRET
    expect((await POST(jsonReq({ text: SMS, from: "MobileMoney" }))).status).toBe(401)
    expect((await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": "" }))).status).toBe(401)
    process.env.SMS_FORWARD_SECRET = ""
    expect((await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": "" }))).status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("401s a wrong or missing header with a generic body", async () => {
    const res = await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": "wrong" }))
    expect(res.status).toBe(401)
    const body = await bodyText(res)
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain("JANE")
    expect((await POST(jsonReq({ text: SMS }, {}))).status).toBe(401)
    expect((await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": SECRET + "x" }))).status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("ignores a secret supplied only in the query string", async () => {
    const res = await POST(jsonReq({ text: SMS }, {}, `${URL_}?secret=${SECRET}&x-sms-forward-secret=${SECRET}`))
    expect(res.status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("accepts JSON {text, from} and passes them to ingest", async () => {
    const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(ingestMock).toHaveBeenCalledTimes(1)
    const [client, input, s] = ingestMock.mock.calls[0]
    expect(client).toEqual({ tag: "admin-client" })
    expect(input).toEqual({ text: SMS, from: "MobileMoney" })
    expect(s).toEqual({ enabled: true, senderAllowlist: ["MobileMoney"] })
  })

  it("accepts form-encoded text and sender", async () => {
    const res = await POST(formReq(new URLSearchParams({ text: SMS, sender: "MobileMoney" }).toString()))
    expect(res.status).toBe(200)
    expect(ingestMock.mock.calls[0][1]).toEqual({ text: SMS, from: "MobileMoney" })
  })

  it.each(["body", "message", "sms", "content"])("accepts the %s field", async (field) => {
    const res = await POST(jsonReq({ [field]: SMS, from: "MobileMoney" }))
    expect(res.status).toBe(200)
    expect(ingestMock.mock.calls[0][1]).toEqual({ text: SMS, from: "MobileMoney" })
  })

  it("takes the first non-empty text field", async () => {
    await POST(jsonReq({ text: "  ", body: "", message: SMS }))
    expect(ingestMock.mock.calls[0][1]).toEqual({ text: SMS, from: null })
  })

  it("never echoes the SMS in the response, whatever the outcome", async () => {
    for (const outcome of ["credited", "flagged", "unparsed", "duplicate", "ignored"]) {
      ingestMock.mockResolvedValueOnce(outcome)
      const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
      expect(res.status).toBe(200)
      const body = await bodyText(res)
      expect(body).toBe(JSON.stringify({ ok: true }))
    }
  })

  it("answers 200 without ingesting for bad JSON, multipart, missing text or non-string fields", async () => {
    const bad = new NextRequest(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sms-forward-secret": SECRET },
      body: "{not json",
    })
    expect((await POST(bad)).status).toBe(200)
    const fd = new FormData()
    fd.set("text", SMS)
    const multi = new NextRequest(URL_, { method: "POST", headers: { "x-sms-forward-secret": SECRET }, body: fd })
    expect((await POST(multi)).status).toBe(200)
    expect((await POST(jsonReq({ from: "MobileMoney" }))).status).toBe(200)
    expect((await POST(jsonReq({ text: 123, from: "MobileMoney" }))).status).toBe(200)
    expect((await POST(jsonReq(["array"]))).status).toBe(200)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("passes a non-string sender as null", async () => {
    await POST(jsonReq({ text: SMS, from: 5 }))
    expect(ingestMock.mock.calls[0][1]).toEqual({ text: SMS, from: null })
  })

  it("503s when the row could not be stored, so the forwarder retries", async () => {
    ingestMock.mockRejectedValueOnce(new MomoStoreError())
    const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
    expect(res.status).toBe(503)
    expect(await bodyText(res)).not.toContain("JANE")
  })

  it("logs only the error name and code on failure, never the message", async () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint (transaction_id)=(80000000123)'), {
      name: "PostgrestError",
      code: "23505",
    })
    ingestMock.mockRejectedValueOnce(err)
    const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
    expect(res.status).toBe(503)
    const errorSpy = logSpies[3]
    const dump = JSON.stringify(errorSpy.mock.calls)
    expect(dump).toContain("PostgrestError")
    expect(dump).toContain("23505")
    expect(dump).not.toContain("duplicate key")
  })

  it("503s when the service role key is absent", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
    expect(res.status).toBe(503)
    expect(ingestMock).not.toHaveBeenCalled()
  })
})
