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

const acceptMock = vi.fn()
const processMock = vi.fn()
vi.mock("@/lib/text-to-buy/handle-inbound", () => ({
  acceptInbound: (...a: unknown[]) => acceptMock(...a),
  processInbound: (...a: unknown[]) => processMock(...a),
}))
const ttbSettingsMock = vi.fn()
vi.mock("@/lib/text-to-buy/settings", () => ({
  loadTtbSettings: (...a: unknown[]) => ttbSettingsMock(...a),
}))
const heartbeatMock = vi.fn()
vi.mock("@/lib/text-to-buy/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/text-to-buy/store")>("@/lib/text-to-buy/store")
  return { ...actual, touchHeartbeat: (...a: unknown[]) => heartbeatMock(...a) }
})
// after() only works inside a request scope: collect the callbacks and run them on demand.
let afterQueue: Array<() => unknown>
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server")
  return { ...actual, after: (cb: () => unknown) => void afterQueue.push(cb) }
})
const runAfter = async () => {
  for (const cb of afterQueue.splice(0)) await cb()
}

import { POST } from "./route"
import { MomoStoreError } from "@/lib/momo-claim/ingest"
import { TtbStoreError } from "@/lib/text-to-buy/store"

const SECRET = "s3cret-value-for-tests-0123456789"
const SECRET_MAIN = "main-only-secret-for-tests-9876543210"
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
  afterQueue = []
  acceptMock.mockResolvedValue({ id: "msg-1", duplicate: false, processed: false })
  processMock.mockResolvedValue({ outcome: "prompted", readBy: "rules", reply: null })
  ttbSettingsMock.mockResolvedValue({ mainEnabled: false, staleMinutes: 10 })
  heartbeatMock.mockResolvedValue(undefined)
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})
afterEach(() => {
  delete process.env.SMS_FORWARD_SECRET
  delete process.env.SMS_FORWARD_SECRET_MAIN
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

describe("POST /api/webhooks/sms-forward: Text-to-Buy fork", () => {
  const ON = { mainEnabled: true, staleMinutes: 10 }
  const mainHeaders = { "x-sms-forward-secret": SECRET_MAIN }
  const laneNotCalled = () => {
    expect(acceptMock).not.toHaveBeenCalled()
    expect(processMock).not.toHaveBeenCalled()
  }

  it("exports a 60 second maxDuration and stays dynamic", async () => {
    const mod = await import("./route")
    expect(mod.maxDuration).toBe(60)
    expect(mod.dynamic).toBe("force-dynamic")
  })

  it("switch off: a text from a personal number goes to ingest exactly as before, lane untouched", async () => {
    const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }))
    expect(res.status).toBe(200)
    expect(ingestMock).toHaveBeenCalledTimes(1)
    expect(ingestMock.mock.calls[0][1]).toEqual({ text: "5gb", from: "0200000101" })
    laneNotCalled()
  })

  it("switch off because the settings read throws: same as off", async () => {
    ttbSettingsMock.mockRejectedValueOnce(new Error("db down"))
    const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }))
    expect(res.status).toBe(200)
    expect(ingestMock).toHaveBeenCalledTimes(1)
    laneNotCalled()
  })

  it("switch on: an allowlisted sender goes to ingest even if the text looks like an order", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    const res = await POST(jsonReq({ text: "5gb", from: "MobileMoney" }))
    expect(res.status).toBe(200)
    expect(ingestMock).toHaveBeenCalledTimes(1)
    laneNotCalled()
  })

  it("switch on: the allowlist is checked first, even for a phone-number entry", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    settingsMock.mockResolvedValue({ enabled: true, senderAllowlist: ["MobileMoney", "0200000150"] })
    await POST(jsonReq({ text: SMS, from: "0200000150" }))
    expect(ingestMock).toHaveBeenCalledTimes(1)
    laneNotCalled()
  })

  it("switch on: a MoMo-looking text from a personal number is an order text, never parsed as a payment", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    const text = "Payment received for GHS 500.00 from X Current Balance GHS 1.00. Transaction ID: 123456789."
    const res = await POST(jsonReq({ text, from: "0200000101" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(ingestMock).not.toHaveBeenCalled()
    expect(acceptMock).toHaveBeenCalledTimes(1)
    const [client, input] = acceptMock.mock.calls[0]
    expect(client).toEqual({ tag: "admin-client" })
    expect(input.line).toBe("main")
    expect(input.from).toBe("0200000101")
    expect(input.text).toBe(text)
    expect(input.receivedAt).toBeNull()
  })

  it.each(["+233200000101", "233200000101", "0200000101"])("switch on: sender %s reaches the lane as 0200000101", async (from) => {
    ttbSettingsMock.mockResolvedValue(ON)
    await POST(jsonReq({ text: "5gb", from }))
    expect(ingestMock).not.toHaveBeenCalled()
    expect(acceptMock.mock.calls[0][1].from).toBe("0200000101")
  })

  it.each(["MTN", "1234", "Vodafone Cash", "+4420000101", "020000010"])(
    "switch on: sender %s is not a customer number, so ingest handles it as today",
    async (from) => {
      ttbSettingsMock.mockResolvedValue(ON)
      const res = await POST(jsonReq({ text: "5gb", from }))
      expect(res.status).toBe(200)
      expect(ingestMock).toHaveBeenCalledTimes(1)
      laneNotCalled()
    },
  )

  it("switch on: a missing sender is not a customer number", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    await POST(jsonReq({ text: "5gb" }))
    expect(ingestMock).toHaveBeenCalledTimes(1)
    laneNotCalled()
  })

  it("503s when the inbound row cannot be stored, so the forwarder retries, and schedules nothing", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    acceptMock.mockRejectedValueOnce(new TtbStoreError("could not store the message"))
    const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }))
    expect(res.status).toBe(503)
    expect(afterQueue).toHaveLength(0)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("a duplicate that was already processed answers 200 and schedules nothing", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    acceptMock.mockResolvedValueOnce({ id: "msg-1", duplicate: true, processed: true })
    const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }))
    expect(res.status).toBe(200)
    expect(afterQueue).toHaveLength(0)
    await runAfter()
    expect(processMock).not.toHaveBeenCalled()
  })

  it("a duplicate that was never processed is processed now", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    acceptMock.mockResolvedValueOnce({ id: "msg-1", duplicate: true, processed: false })
    const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }))
    expect(res.status).toBe(200)
    expect(afterQueue).toHaveLength(1)
    await runAfter()
    expect(processMock).toHaveBeenCalledTimes(1)
  })

  it("processes a new message in after(), with the real time at that moment and the parsed received time", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    const settings = { mainEnabled: true, staleMinutes: 10 }
    ttbSettingsMock.mockResolvedValue(settings)
    const received = new Date(Date.now() - 60_000).toISOString()
    const res = await POST(jsonReq({ text: "5gb", from: "0200000101", received }))
    expect(res.status).toBe(200)
    expect(processMock).not.toHaveBeenCalled() // deferred, not run inline
    expect(afterQueue).toHaveLength(1)
    const before = Date.now()
    await runAfter()
    const after = Date.now()
    expect(processMock).toHaveBeenCalledTimes(1)
    const [client, id, input, passedSettings] = processMock.mock.calls[0]
    expect(client).toEqual({ tag: "admin-client" })
    expect(id).toBe("msg-1")
    expect(passedSettings).toBe(settings)
    expect(input.line).toBe("main")
    expect(input.from).toBe("0200000101")
    expect(input.text).toBe("5gb")
    expect(input.receivedAt).toEqual(new Date(received))
    expect(input.now.getTime()).toBeGreaterThanOrEqual(before)
    expect(input.now.getTime()).toBeLessThanOrEqual(after)
  })

  it("never lets a processInbound failure escape after(), and logs only the id and error name", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    processMock.mockRejectedValueOnce(Object.assign(new Error("boom 0200000101 5gb"), { name: "SomeError" }))
    await POST(jsonReq({ text: "5gb", from: "0200000101" }))
    await expect(runAfter()).resolves.toBeUndefined()
    const dump = JSON.stringify(logSpies[3].mock.calls)
    expect(dump).toContain("SomeError")
    expect(dump).not.toContain("0200000101")
    expect(dump).not.toContain("boom")
  })

  it("accepts every received alias and form, and a garbage value becomes null", async () => {
    ttbSettingsMock.mockResolvedValue(ON)
    const when = new Date(Date.now() - 90_000)
    const secs = Math.floor(when.getTime() / 1000) * 1000
    const iso = new Date(secs).toISOString()
    const plain = iso.slice(0, 19).replace("T", " ")
    const cases: Array<[Record<string, unknown>, number | null]> = [
      [{ received: iso }, secs],
      [{ time: plain }, secs],
      [{ receive_time: String(secs / 1000) }, secs],
      [{ date: secs }, secs],
      [{ received: "not a time" }, null],
      [{}, null],
      [{ received: "", time: iso }, secs], // empty is skipped; the next alias wins
      [{ received: iso, time: "2021-01-01 00:00:00" }, secs], // priority order
    ]
    for (const [extra, expected] of cases) {
      acceptMock.mockClear()
      await POST(jsonReq({ text: "5gb", from: "0200000101", ...extra }))
      const got = acceptMock.mock.calls[0][1].receivedAt as Date | null
      expect(got ? got.getTime() : null).toBe(expected)
    }
    acceptMock.mockClear()
    await POST(formReq(new URLSearchParams({ text: "5gb", from: "0200000101", time: plain }).toString()))
    expect((acceptMock.mock.calls[0][1].receivedAt as Date).getTime()).toBe(secs)
  })

  it("records the heartbeat for the main line, and a heartbeat failure never fails the request", async () => {
    await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
    expect(heartbeatMock).toHaveBeenCalledTimes(1)
    expect(heartbeatMock.mock.calls[0][1]).toBe("main")
    expect(heartbeatMock.mock.calls[0][2]).toBeInstanceOf(Date)

    heartbeatMock.mockRejectedValueOnce(new TtbStoreError("could not record the heartbeat"))
    const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
    expect(res.status).toBe(200)
    expect(ingestMock).toHaveBeenCalledTimes(2)
  })

  it("does not record a heartbeat for an unusable body or a bad secret", async () => {
    await POST(jsonReq({ from: "MobileMoney" }))
    await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": "wrong" }))
    expect(heartbeatMock).not.toHaveBeenCalled()
  })

  describe("SMS_FORWARD_SECRET_MAIN", () => {
    beforeEach(() => {
      process.env.SMS_FORWARD_SECRET_MAIN = SECRET_MAIN
    })

    it("is accepted, but the MoMo lane is not honoured on it: a MobileMoney notice is never ingested", async () => {
      ttbSettingsMock.mockResolvedValue(ON)
      const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }, mainHeaders))
      expect(res.status).toBe(200)
      expect(ingestMock).not.toHaveBeenCalled()
      expect(settingsMock).not.toHaveBeenCalled()
      laneNotCalled()
      expect(heartbeatMock).toHaveBeenCalledTimes(1)
    })

    it("switch on: a personal number reaches the lane", async () => {
      ttbSettingsMock.mockResolvedValue(ON)
      const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }, mainHeaders))
      expect(res.status).toBe(200)
      expect(ingestMock).not.toHaveBeenCalled()
      expect(acceptMock).toHaveBeenCalledTimes(1)
    })

    it("switch off: answers ok and stores nothing", async () => {
      const res = await POST(jsonReq({ text: "5gb", from: "0200000101" }, mainHeaders))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(ingestMock).not.toHaveBeenCalled()
      laneNotCalled()
    })

    it("a store failure still 503s so the forwarder retries", async () => {
      ttbSettingsMock.mockResolvedValue(ON)
      acceptMock.mockRejectedValueOnce(new TtbStoreError("could not store the message"))
      expect((await POST(jsonReq({ text: "5gb", from: "0200000101" }, mainHeaders))).status).toBe(503)
    })

    it("the primary secret keeps the MoMo lane while the main secret is set", async () => {
      await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
      expect(ingestMock).toHaveBeenCalledTimes(1)
    })

    it("identical secrets resolve to the primary (MoMo lane) source", async () => {
      process.env.SMS_FORWARD_SECRET_MAIN = SECRET
      await POST(jsonReq({ text: SMS, from: "MobileMoney" }))
      expect(ingestMock).toHaveBeenCalledTimes(1)
    })

    it("an empty main secret authorises nothing", async () => {
      process.env.SMS_FORWARD_SECRET_MAIN = ""
      const res = await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": "" }))
      expect(res.status).toBe(401)
    })

    it("a wrong or missing header is still 401 with nothing called", async () => {
      expect((await POST(jsonReq({ text: SMS }, { "x-sms-forward-secret": SECRET_MAIN + "x" }))).status).toBe(401)
      expect((await POST(jsonReq({ text: SMS }, {}))).status).toBe(401)
      expect(ingestMock).not.toHaveBeenCalled()
      expect(heartbeatMock).not.toHaveBeenCalled()
      laneNotCalled()
    })
  })

  it("the main secret is ignored when the env is unset (header equal to nothing is 401)", async () => {
    const res = await POST(jsonReq({ text: SMS, from: "MobileMoney" }, mainHeaders))
    expect(res.status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })
})
