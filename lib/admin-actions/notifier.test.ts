import { createNotifier } from "./notifier"
import type { FlowDef, NotifierDeps } from "./types"

type C = { id: string }
const flow: FlowDef<C> = {
  adminAlert: (c) => ({ subject: `New ${c.id}`, html: "<p>x</p>", pushTitle: "New", pushBody: c.id, url: "/admin/x" }),
  userMessage: (o, c) =>
    o === "approved"
      ? {
          emailSubject: "Approved", emailHtml: "<p>ok</p>", sms: `Approved ${c.id}`,
          push: { title: "P", body: "B", url: "/u" },
          inApp: { title: "T", message: "M", type: "withdrawal_approved", actionUrl: "/u" },
        }
      : o === "rejected"
      ? { emailSubject: "Rejected", emailHtml: "<p>no</p>", sms: "Rejected" }
      : null,
}
const registry = { f: flow }

function fakeDeps(over: Partial<NotifierDeps> = {}) {
  const calls = { email: [] as any[], sms: [] as any[], push: [] as any[], adminEmail: [] as any[], adminPush: [] as any[], inApp: [] as any[] }
  const deps: NotifierDeps = {
    sendEmail: async (p) => { calls.email.push(p) },
    sendSMS: async (p) => { calls.sms.push(p) },
    sendPushToUser: async (u, p) => { calls.push.push([u, p]) },
    notifyAdminsEmail: async (s, h) => { calls.adminEmail.push([s, h]) },
    notifyAdminsPush: async (p) => { calls.adminPush.push(p) },
    insertNotification: async (row) => { calls.inApp.push(row); return { error: null } },
    getRecipient: async (id) => ({ userId: id, email: "u@example.com", phone: "0241112222", name: "Ama" }),
    ...over,
  }
  return { deps, calls }
}
const statusOf = (r: { channel: string; status: string }[], ch: string) => r.find((x) => x.channel === ch)?.status

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe("alertAdminsOfRequest", () => {
  it("sends admin email and push with the deep link", async () => {
    const { deps, calls } = fakeDeps()
    const r = await createNotifier(registry, deps).alertAdminsOfRequest("f", { id: "W1" })
    expect(calls.adminEmail).toEqual([["New W1", "<p>x</p>"]])
    expect(calls.adminPush).toEqual([{ title: "New", body: "W1", data: { url: "/admin/x" } }])
    expect(statusOf(r, "admin_email")).toBe("sent")
    expect(statusOf(r, "admin_push")).toBe("sent")
  })
  it("a failing email does not stop the push and never throws", async () => {
    const { deps, calls } = fakeDeps({ notifyAdminsEmail: async () => { throw new Error("smtp down") } })
    const r = await createNotifier(registry, deps).alertAdminsOfRequest("f", { id: "W1" })
    expect(statusOf(r, "admin_email")).toBe("failed")
    expect(statusOf(r, "admin_push")).toBe("sent")
    expect(calls.adminPush).toHaveLength(1)
  })
  it("unknown flow or a throwing template returns [] without throwing", async () => {
    const { deps } = fakeDeps()
    const n = createNotifier({ ...registry, bad: { adminAlert: () => { throw new Error("tpl") }, userMessage: () => null } }, deps)
    expect(await n.alertAdminsOfRequest("nope", {})).toEqual([])
    expect(await n.alertAdminsOfRequest("bad", {})).toEqual([])
  })
  it("a hung provider times out at 8s and is reported failed", async () => {
    vi.useFakeTimers()
    const { deps } = fakeDeps({ notifyAdminsPush: () => new Promise(() => {}) })
    const p = createNotifier(registry, deps).alertAdminsOfRequest("f", { id: "W1" })
    await vi.advanceTimersByTimeAsync(8100)
    const r = await p
    expect(statusOf(r, "admin_push")).toBe("failed")
    expect(statusOf(r, "admin_email")).toBe("sent")
  })
})

describe("notifyUserOfOutcome", () => {
  it("approved: email + sms + push + in-app, using the account's contact details", async () => {
    const { deps, calls } = fakeDeps()
    const r = await createNotifier(registry, deps).notifyUserOfOutcome("f", "approved", { userId: "u1", reference: "R1" }, { id: "W1" })
    expect(calls.email[0]).toMatchObject({ to: [{ email: "u@example.com", name: "Ama" }], subject: "Approved", referenceId: "R1", userId: "u1", type: "f_approved" })
    expect(calls.sms[0]).toEqual({ phone: "0241112222", message: "Approved W1", type: "f_approved", reference: "R1", userId: "u1" })
    expect(calls.push[0][0]).toBe("u1")
    expect(calls.inApp[0]).toMatchObject({ user_id: "u1", title: "T", message: "M", type: "withdrawal_approved", reference_id: "R1", action_url: "/u", read: false })
    expect(r.map((x) => x.status)).toEqual(["sent", "sent", "sent", "sent"])
  })
  it("explicit phone/email override the account's (guest or registrant phone)", async () => {
    const { deps, calls } = fakeDeps()
    await createNotifier(registry, deps).notifyUserOfOutcome("f", "rejected", { userId: "u1", phone: "0200000000", email: "x@y.z" }, { id: "W1" })
    expect(calls.sms[0].phone).toBe("0200000000")
    expect(calls.email[0].to[0].email).toBe("x@y.z")
  })
  it("guest with no userId: sms to the given phone, email/push/in-app skipped, no lookup", async () => {
    const getRecipient = vi.fn()
    const { deps, calls } = fakeDeps({ getRecipient })
    const r = await createNotifier(registry, deps).notifyUserOfOutcome("f", "approved", { phone: "0201234567" }, { id: "W1" })
    expect(getRecipient).not.toHaveBeenCalled()
    expect(calls.sms).toHaveLength(1)
    expect(statusOf(r, "user_email")).toBe("skipped")
    expect(statusOf(r, "user_push")).toBe("skipped")
    expect(statusOf(r, "user_inapp")).toBe("skipped")
  })
  it("skips email when the account has none, skips sms when it has no phone", async () => {
    const { deps, calls } = fakeDeps({ getRecipient: async (id) => ({ userId: id, email: null, phone: null, name: null }) })
    const r = await createNotifier(registry, deps).notifyUserOfOutcome("f", "rejected", { userId: "u1" }, { id: "W1" })
    expect(calls.email).toHaveLength(0)
    expect(calls.sms).toHaveLength(0)
    expect(statusOf(r, "user_email")).toBe("skipped")
    expect(statusOf(r, "user_sms")).toBe("skipped")
  })
  it("clips an over-long SMS to 160 chars centrally", async () => {
    const long: FlowDef<C> = { ...flow, userMessage: () => ({ emailSubject: "Subject", emailHtml: "<p>x</p>", sms: "y".repeat(400) }) }
    const { deps, calls } = fakeDeps()
    await createNotifier({ f: long }, deps).notifyUserOfOutcome("f", "approved", { userId: "u1" }, { id: "W1" })
    expect(calls.sms[0].message).toHaveLength(160)
    expect(calls.sms[0].message.endsWith("...")).toBe(true)
  })
  it("an outcome the flow does not message returns [] and sends nothing", async () => {
    const { deps, calls } = fakeDeps()
    expect(await createNotifier(registry, deps).notifyUserOfOutcome("f", "resolved", { userId: "u1" }, { id: "W1" })).toEqual([])
    expect(calls.email.length + calls.sms.length).toBe(0)
  })
  it("failures are isolated per channel and in-app insert errors are reported, not thrown", async () => {
    const { deps, calls } = fakeDeps({
      sendEmail: async () => { throw new Error("email down") },
      insertNotification: async () => ({ error: { message: "rls" } }),
    })
    const r = await createNotifier(registry, deps).notifyUserOfOutcome("f", "approved", { userId: "u1" }, { id: "W1" })
    expect(statusOf(r, "user_email")).toBe("failed")
    expect(statusOf(r, "user_inapp")).toBe("failed")
    expect(statusOf(r, "user_sms")).toBe("sent")
    expect(calls.sms).toHaveLength(1)
  })
  it("a throwing recipient lookup falls back to explicit targets and never throws", async () => {
    const { deps, calls } = fakeDeps({ getRecipient: async () => { throw new Error("db") } })
    const r = await createNotifier(registry, deps).notifyUserOfOutcome("f", "rejected", { userId: "u1", phone: "0200000000" }, { id: "W1" })
    expect(calls.sms).toHaveLength(1)
    expect(statusOf(r, "user_email")).toBe("skipped")
  })
})

describe("summary log", () => {
  it("logs one line per outcome call with channel names only, no contact data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { deps } = fakeDeps({ sendSMS: async () => { throw new Error("0241112222 boom") } })
    await createNotifier(registry, deps).notifyUserOfOutcome("f", "approved", { userId: "u1", reference: "R1" }, { id: "W1" })
    const lines = log.mock.calls.filter((c) => c[0] === "[ADMIN-ACTION]")
    expect(lines).toHaveLength(1)
    expect(lines[0].slice(1, 4)).toEqual(["f", "approved", "R1"])
    expect(lines[0][4]).toBe("sent=3 skipped=- failed=user_sms")
    const text = JSON.stringify(lines)
    expect(text).not.toMatch(/u@example\.com|0241112222|Approved W1/)
  })
  it("logs one line per alert call", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { deps } = fakeDeps()
    await createNotifier(registry, deps).alertAdminsOfRequest("f", { id: "W1" })
    const lines = log.mock.calls.filter((c) => c[0] === "[ADMIN-ACTION]")
    expect(lines).toHaveLength(1)
    expect(lines[0].slice(1)).toEqual(["f", "alert", "-", "sent=2 skipped=- failed=-"])
  })
})
