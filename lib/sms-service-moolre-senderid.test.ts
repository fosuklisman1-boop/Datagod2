import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPost = vi.hoisted(() => {
  process.env.MOOLRE_API_KEY = "test-moolre-key"
  return vi.fn()
})
vi.mock("axios", () => ({
  default: { post: mockPost, isAxiosError: () => false },
}))

import { queryMoolreSenderIdStatus } from "./sms-service"

beforeEach(() => {
  mockPost.mockReset()
})

describe("queryMoolreSenderIdStatus", () => {
  it("maps ASMQ02 to active", async () => {
    mockPost.mockResolvedValue({ data: { status: 1, code: "ASMQ02", data: "DTGOD" } })
    const result = await queryMoolreSenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "ASMQ02", localStatus: "active" })
  })

  it("maps ASMQ07 to rejected", async () => {
    mockPost.mockResolvedValue({ data: { status: 1, code: "ASMQ07" } })
    const result = await queryMoolreSenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "ASMQ07", localStatus: "rejected" })
  })

  it("treats status:0 as a failure sentinel instead of storing the error code as a real status (real production bug: IE01 'INTERNAL ERROR' was silently stored as moolre_status for months)", async () => {
    mockPost.mockResolvedValue({ data: { status: 0, code: "IE01", message: "INTERNAL ERROR", data: "all" } })
    const result = await queryMoolreSenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "error", localStatus: "pending" })
  })

  it("falls back to the error sentinel on a network/axios exception", async () => {
    mockPost.mockRejectedValue(new Error("network down"))
    const result = await queryMoolreSenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "error", localStatus: "pending" })
  })
})
