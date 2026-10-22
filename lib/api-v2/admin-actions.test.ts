import { describe, it, expect } from "vitest"
import { planKeyPatch, summarizeKill } from "./admin-actions"

describe("summarizeKill", () => {
  it("all three succeed: 200, success true, counts reported", () => {
    const r = summarizeKill({ v1: { ok: true }, v2Keys: { ok: true, count: 4 }, v2Config: { ok: true } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, v1Disabled: true, v2Revoked: 4, v2Disabled: true })
    expect(r.body.message).toContain("4 v2 keys")
    expect(r.body.message).toMatch(/v2 API (is now )?(turned )?off/i)
  })

  it("v1 failed, v2 ok: 500 and the message names exactly what did and did not happen", () => {
    const r = summarizeKill({ v1: { ok: false }, v2Keys: { ok: true, count: 2 }, v2Config: { ok: true } })
    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ success: false, v1Disabled: false, v2Revoked: 2, v2Disabled: true })
    expect(r.body.message).toMatch(/Succeeded: .*2 v2 keys revoked.*v2 API turned off/)
    expect(r.body.message).toMatch(/Failed: v1 keys disabled\./)
  })

  it("v2 key revoke failed: 500, v2Revoked null", () => {
    const r = summarizeKill({ v1: { ok: true }, v2Keys: { ok: false }, v2Config: { ok: true } })
    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ success: false, v1Disabled: true, v2Revoked: null, v2Disabled: true })
    expect(r.body.message).toMatch(/Failed: v2 keys revoked\./)
    expect(r.body.message).toMatch(/Succeeded: v1 keys disabled, v2 API turned off/)
  })

  it("v2 config disable failed: 500", () => {
    const r = summarizeKill({ v1: { ok: true }, v2Keys: { ok: true, count: 0 }, v2Config: { ok: false } })
    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ success: false, v2Disabled: false })
    expect(r.body.message).toMatch(/Failed: v2 API turned off\./)
  })

  it("everything failed: 500 and nothing claimed as succeeded", () => {
    const r = summarizeKill({ v1: { ok: false }, v2Keys: { ok: false }, v2Config: { ok: false } })
    expect(r.status).toBe(500)
    expect(r.body.success).toBe(false)
    expect(r.body.message).toMatch(/Succeeded: nothing\./)
    expect(r.body.message).toMatch(/Failed: v1 keys disabled, v2 keys revoked, v2 API turned off\./)
  })
})

const now = new Date("2026-10-22T12:00:00.000Z")
const iso = now.toISOString()

describe("planKeyPatch", () => {
  it("approves a pending key", () => {
    expect(planKeyPatch({ status: "pending" }, { action: "approve" }, now)).toEqual({
      ok: true,
      update: { status: "active", approved_at: iso, updated_at: iso },
    })
  })
  it("rejects approving a revoked or active key with 409", () => {
    for (const status of ["revoked", "active"] as const) {
      const r = planKeyPatch({ status }, { action: "approve" }, now)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(409)
    }
  })
  it("revokes a pending or active key", () => {
    for (const status of ["pending", "active"] as const) {
      expect(planKeyPatch({ status }, { action: "revoke" }, now)).toEqual({
        ok: true,
        update: { status: "revoked", revoked_at: iso, updated_at: iso },
      })
    }
  })
  it("rejects revoking a revoked key with 409", () => {
    const r = planKeyPatch({ status: "revoked" }, { action: "revoke" }, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })
  it("sets limits on an active key", () => {
    expect(planKeyPatch({ status: "active" }, { action: "set_limits", limits: { purchase: 20 } }, now)).toEqual({
      ok: true,
      update: { rate_limits: { purchase: 20 }, updated_at: iso },
    })
  })
  it("rejects invalid limits with 400", () => {
    const r = planKeyPatch({ status: "active" }, { action: "set_limits", limits: { purchase: 0 } }, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })
  it("rejects set_limits and reset_limits on a revoked key with 409", () => {
    for (const body of [{ action: "set_limits", limits: { purchase: 5 } }, { action: "reset_limits" }]) {
      const r = planKeyPatch({ status: "revoked" }, body, now)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(409)
    }
  })
  it("invalid limits on a revoked key return 400 (limits are validated before the revoked check)", () => {
    const r = planKeyPatch({ status: "revoked" }, { action: "set_limits", limits: { purchase: 0 } }, now)
    expect(r).toMatchObject({ ok: false, status: 400 })
  })
  it("resets limits to null", () => {
    expect(planKeyPatch({ status: "pending" }, { action: "reset_limits" }, now)).toEqual({
      ok: true,
      update: { rate_limits: null, updated_at: iso },
    })
  })
  it("rejects unknown actions and non-object bodies with 400", () => {
    for (const body of [{ action: "nuke" }, {}, null, "approve", 5, [], undefined]) {
      const r = planKeyPatch({ status: "active" }, body, now)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
    }
  })
})
