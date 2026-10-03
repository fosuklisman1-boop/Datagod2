import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPost = vi.hoisted(() => {
  process.env.MNOTIFY_API_KEY = "test-mnotify-key"
  return vi.fn()
})
vi.mock("axios", () => ({
  default: { post: mockPost, isAxiosError: () => false },
}))

import { createMnotifySenderId, queryMnotifySenderIdStatus } from "./mnotify-sender-id"

beforeEach(() => {
  mockPost.mockReset()
})

describe("createMnotifySenderId", () => {
  it("returns ok:true on a successful registration", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", message: "Sender ID Successfully Registered.", summary: { status: "Pending" } } })
    const result = await createMnotifySenderId("DTGOD")
    expect(result.ok).toBe(true)
  })

  it("returns ok:false when mNotify reports a non-success status", async () => {
    mockPost.mockResolvedValue({ data: { status: "error", message: "Sender ID already exists" } })
    const result = await createMnotifySenderId("DTGOD")
    expect(result.ok).toBe(false)
  })

  it("returns ok:false on a network error", async () => {
    mockPost.mockRejectedValue(new Error("network down"))
    const result = await createMnotifySenderId("DTGOD")
    expect(result.ok).toBe(false)
  })
})

describe("queryMnotifySenderIdStatus", () => {
  it("maps Approved to active", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", summary: { status: "Approved" } } })
    const result = await queryMnotifySenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "Approved", localStatus: "active" })
  })

  it("maps Rejected to rejected", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", summary: { status: "Rejected" } } })
    const result = await queryMnotifySenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "Rejected", localStatus: "rejected" })
  })

  it("maps Pending (and anything unrecognized) to pending", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", summary: { status: "Pending" } } })
    expect(await queryMnotifySenderIdStatus("DTGOD")).toEqual({ rawStatus: "Pending", localStatus: "pending" })
  })

  it("treats a non-success response as a failure sentinel instead of trusting its body (same class of bug just fixed for Moolre)", async () => {
    mockPost.mockResolvedValue({ data: { status: "error", message: "Sender ID not found" } })
    const result = await queryMnotifySenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "error", localStatus: "pending" })
  })

  it("falls back to the error sentinel on a network/axios exception", async () => {
    mockPost.mockRejectedValue(new Error("network down"))
    expect(await queryMnotifySenderIdStatus("DTGOD")).toEqual({ rawStatus: "error", localStatus: "pending" })
  })
})
