import { describe, it, expect, vi, beforeEach } from "vitest"

const sendPushToUser = vi.fn()
const alertAdminsOfRequest = vi.fn()
const after = vi.fn()
vi.mock("@/lib/push-service", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }))
vi.mock("@/lib/admin-actions", () => ({ alertAdminsOfRequest: (...a: unknown[]) => alertAdminsOfRequest(...a) }))
vi.mock("next/server", () => ({ after: (...a: unknown[]) => after(...a) }))

import { notifyUserSupportEvent, alertAdminsNewThread, runAfterResponse } from "./support-notify"

function fakeDb(error: any = null) {
  const insert = vi.fn().mockResolvedValue({ error })
  const from = vi.fn(() => ({ insert }))
  return { db: { from } as any, insert, from }
}

beforeEach(() => {
  sendPushToUser.mockReset().mockResolvedValue({ sent: 1, removed: 0 })
  alertAdminsOfRequest.mockReset().mockResolvedValue([])
  after.mockReset()
})

const COPY = {
  received: ["We received your complaint", "Our support team will reply here shortly."],
  replied: ["Support replied to your complaint", "Open Support & Complaints to read the reply."],
  closed: ["Your complaint was closed", "Open a new complaint if you still need help."],
} as const

describe("notifyUserSupportEvent", () => {
  for (const event of ["received", "replied", "closed"] as const) {
    it(`${event}: inserts the notification and sends the push with exact copy`, async () => {
      const { db, insert, from } = fakeDb()
      await notifyUserSupportEvent(db, "u1", event, "t1")
      expect(from).toHaveBeenCalledWith("notifications")
      expect(insert).toHaveBeenCalledWith({
        user_id: "u1", title: COPY[event][0], message: COPY[event][1], type: "support_reply",
        reference_id: "t1", action_url: "/dashboard/complaints", read: false,
      })
      expect(sendPushToUser).toHaveBeenCalledWith("u1", {
        title: COPY[event][0], body: COPY[event][1], data: { url: "/dashboard/complaints" },
      })
    })
  }

  it("still pushes when the notification insert errors", async () => {
    const { db } = fakeDb({ message: "boom" })
    await expect(notifyUserSupportEvent(db, "u1", "replied", "t1")).resolves.toBeUndefined()
    expect(sendPushToUser).toHaveBeenCalledTimes(1)
  })
  it("still pushes when the insert throws", async () => {
    const db: any = { from: () => ({ insert: () => Promise.reject(new Error("x")) }) }
    await expect(notifyUserSupportEvent(db, "u1", "replied", "t1")).resolves.toBeUndefined()
    expect(sendPushToUser).toHaveBeenCalledTimes(1)
  })
  it("does not reject when the push rejects", async () => {
    sendPushToUser.mockRejectedValue(new Error("push down"))
    const { db, insert } = fakeDb()
    await expect(notifyUserSupportEvent(db, "u1", "closed", "t1")).resolves.toBeUndefined()
    expect(insert).toHaveBeenCalled()
  })
})

describe("alertAdminsNewThread", () => {
  it("raises the complaint alert with a 200-char summary", async () => {
    await alertAdminsNewThread({ threadId: "t1", subject: "Order missing", summary: "x".repeat(500) })
    expect(alertAdminsOfRequest).toHaveBeenCalledWith("complaint", {
      complaintId: "t1", summary: "x".repeat(200), url: "/admin/complaints", customerLabel: "Order missing",
    })
  })
  it("never rejects", async () => {
    alertAdminsOfRequest.mockRejectedValue(new Error("x"))
    await expect(alertAdminsNewThread({ threadId: "t1", subject: "s", summary: "m" })).resolves.toBeUndefined()
  })
})

describe("runAfterResponse", () => {
  it("hands the task to after()", () => {
    const task = vi.fn().mockResolvedValue(undefined)
    runAfterResponse(task)
    expect(after).toHaveBeenCalledWith(task)
    expect(task).not.toHaveBeenCalled()
  })
  it("runs the task directly when after() throws", async () => {
    after.mockImplementation(() => { throw new Error("outside request scope") })
    const task = vi.fn().mockResolvedValue(undefined)
    runAfterResponse(task)
    await Promise.resolve()
    expect(task).toHaveBeenCalledTimes(1)
  })
  it("swallows a rejection from the detached fallback", async () => {
    after.mockImplementation(() => { throw new Error("x") })
    expect(() => runAfterResponse(() => Promise.reject(new Error("task failed")))).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
