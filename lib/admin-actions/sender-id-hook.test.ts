import { notifySenderIdOutcome } from "./sender-id-hook"

vi.mock("@/lib/admin-actions", () => ({ notifyUserOfOutcome: vi.fn(async () => []) }))
import { notifyUserOfOutcome } from "@/lib/admin-actions"

function fakeDb(account: unknown, opts: { throws?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          if (opts.throws) throw new Error("db down")
          return { data: account, error: null }
        },
      }
      return q
    },
  }
}

beforeEach(() => vi.mocked(notifyUserOfOutcome).mockClear())

const row = { id: "r1", sender_id: "ACME", sms_account_id: "a1" }

describe("notifySenderIdOutcome", () => {
  it("looks up the account owner and notifies", async () => {
    const db = fakeDb({ user_id: "u1" })
    await notifySenderIdOutcome(db as any, row, "rejected", "Too generic")
    expect(db.calls).toEqual(["sms_accounts"])
    expect(notifyUserOfOutcome).toHaveBeenCalledTimes(1)
    expect(notifyUserOfOutcome).toHaveBeenCalledWith("sender_id", "rejected", { userId: "u1", reference: "r1" },
      { senderIdId: "r1", senderId: "ACME", reason: "Too generic" })
  })
  it("approved without reason", async () => {
    await notifySenderIdOutcome(fakeDb({ user_id: "u1" }) as any, row, "approved")
    expect(notifyUserOfOutcome).toHaveBeenCalledWith("sender_id", "approved", { userId: "u1", reference: "r1" },
      { senderIdId: "r1", senderId: "ACME", reason: undefined })
  })
  it("does nothing for platform-owned rows (no account)", async () => {
    const db = fakeDb({ user_id: "u1" })
    await notifySenderIdOutcome(db as any, { ...row, sms_account_id: null }, "approved")
    expect(db.calls).toEqual([])
    expect(notifyUserOfOutcome).not.toHaveBeenCalled()
  })
  it("does nothing when the account row is missing", async () => {
    await notifySenderIdOutcome(fakeDb(null) as any, row, "approved")
    expect(notifyUserOfOutcome).not.toHaveBeenCalled()
  })
  it("never throws", async () => {
    await expect(notifySenderIdOutcome(fakeDb(null, { throws: true }) as any, row, "approved")).resolves.toBeUndefined()
    vi.mocked(notifyUserOfOutcome).mockRejectedValueOnce(new Error("boom"))
    await expect(notifySenderIdOutcome(fakeDb({ user_id: "u" }) as any, row, "approved")).resolves.toBeUndefined()
  })
})
