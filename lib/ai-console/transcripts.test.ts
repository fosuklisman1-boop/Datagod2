import { describe, it, expect, vi } from "vitest"
import { recordTurn, flagConversation, flagCardFailure, refusalLike } from "./transcripts"

type Row = Record<string, any>
/** Tiny in-memory fake of the supabase calls transcripts.ts uses. */
function fakeDb(opts: { failAll?: boolean } = {}) {
  const t: Record<string, Row[]> = { ai_conversations: [], ai_conversation_messages: [], ai_drafts: [] }
  let seq = 0
  const db = {
    t,
    from(table: string) {
      const rows = t[table]
      const filters: Array<(r: Row) => boolean> = []
      let mode: "select" | "insert" | "update" = "select"
      let payload: any
      const run = () => {
        if (opts.failAll) return { data: null, error: { message: "boom +233241234567" } }
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (mode === "insert") {
          const arr = Array.isArray(payload) ? payload : [payload]
          const made = arr.map((p) => ({ id: table === "ai_conversations" ? `c${++seq}` : ++seq, message_count: 0, flag_reasons: [], flagged: false, ...p }))
          rows.push(...made)
          return { data: made, error: null }
        }
        if (mode === "update") { hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null } }
        return { data: hit, error: null }
      }
      const q: any = {
        select: () => q,
        insert: (p: any) => { mode = "insert"; payload = p; return q },
        update: (p: any) => { mode = "update"; payload = p; return q },
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return q },
        maybeSingle: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error } },
        single: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error } },
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      }
      return q
    },
  }
  return db
}
const K = "11111111-1111-4111-8111-111111111111"
const base = { conversationKey: K, context: "home" as const, userText: "hi 0241234567", assistantText: "Hello there" }

describe("recordTurn", () => {
  it("creates the conversation, stores two redacted messages and counts them", async () => {
    const db = fakeDb()
    await recordTurn(db as any, base)
    expect(db.t.ai_conversations).toHaveLength(1)
    expect(db.t.ai_conversations[0].message_count).toBe(2)
    expect(db.t.ai_conversation_messages.map((m) => [m.role, m.text])).toEqual([["user", "hi [phone]"], ["assistant", "Hello there"]])
    await recordTurn(db as any, { ...base, userText: "again", assistantText: "ok" })
    expect(db.t.ai_conversations).toHaveLength(1)
    expect(db.t.ai_conversations[0].message_count).toBe(4)
  })

  it("never stores card notes, nonce or data fences", async () => {
    const db = fakeDb()
    await recordTurn(db as any, { ...base, assistantText: 'Done <card_results nonce="NONCE9">x</card_results> [card 1: ok] <data>t</data>' })
    const all = JSON.stringify(db.t.ai_conversation_messages)
    expect(all).not.toMatch(/NONCE9|card_results|\[card|<data>/)
  })

  it("does not append to a conversation owned by someone else", async () => {
    const db = fakeDb()
    await recordTurn(db as any, { ...base, context: "dashboard", userId: "u1" })
    await recordTurn(db as any, { ...base, context: "dashboard", userId: "u2" })
    expect(db.t.ai_conversation_messages).toHaveLength(2)
  })

  it("admin_turns_not_recorded", async () => {
    const db = fakeDb()
    await recordTurn(db as any, { ...base, context: "admin", userId: "a1" })
    expect(db.t.ai_conversations).toHaveLength(0)
    expect(db.t.ai_conversation_messages).toHaveLength(0)
    // an existing admin row (legacy) is never flagged either
    db.t.ai_conversations.push({ id: "x", conversation_key: K, context: "admin", user_id: "a1", shop_id: null, message_count: 0, flag_reasons: [], flagged: false })
    expect(await flagConversation(db as any, K, "handoff")).toBe(false)
    expect(db.t.ai_conversations[0].flagged).toBe(false)
  })

  it("does not append when the shop differs", async () => {
    const db = fakeDb()
    await recordTurn(db as any, { ...base, context: "storefront", shopId: "s1" })
    await recordTurn(db as any, { ...base, context: "storefront", shopId: "s2" })
    expect(db.t.ai_conversation_messages).toHaveLength(2)
  })

  it("flags a refusal-like reply and merges extra reasons", async () => {
    const db = fakeDb()
    await recordTurn(db as any, { ...base, assistantText: "I'm sorry, I can't help with that.", extraReasons: ["error"] })
    expect(db.t.ai_conversations[0].flagged).toBe(true)
    expect([...db.t.ai_conversations[0].flag_reasons].sort()).toEqual(["error", "refusal"])
  })

  it("record_turn_failure_never_throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(recordTurn(fakeDb({ failAll: true }) as any, base)).resolves.toBeUndefined()
    await expect(recordTurn({ from: () => { throw new Error("0241234567") } } as any, base)).resolves.toBeUndefined()
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toMatch(/0241234567|233241234567/)
    spy.mockRestore()
  })
})

describe("flagConversation", () => {
  it("flags an existing conversation once per reason and reports whether it existed", async () => {
    const db = fakeDb()
    expect(await flagConversation(db as any, K, "handoff")).toBe(false)
    expect(db.t.ai_conversations).toHaveLength(0)
    await recordTurn(db as any, base)
    expect(await flagConversation(db as any, K, "handoff")).toBe(true)
    expect(await flagConversation(db as any, K, "handoff")).toBe(true)
    expect(db.t.ai_conversations[0].flag_reasons).toEqual(["handoff"])
    expect(db.t.ai_conversations[0].flagged).toBe(true)
  })
  it("swallows failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await flagConversation(fakeDb({ failAll: true }) as any, K, "error")).toBe(false)
    spy.mockRestore()
  })
})

describe("flagCardFailure", () => {
  it("flags the drafting conversation only for failed / unknown cards", async () => {
    const db = fakeDb()
    await recordTurn(db as any, base)
    db.t.ai_drafts.push({ id: "d1", conversation_key: K }, { id: "d2", conversation_key: null })
    await flagCardFailure(db as any, "d1", "succeeded")
    expect(db.t.ai_conversations[0].flagged).toBe(false)
    await flagCardFailure(db as any, "d2", "failed")
    expect(db.t.ai_conversations[0].flagged).toBe(false)
    await flagCardFailure(db as any, "d1", "failed")
    expect(db.t.ai_conversations[0].flag_reasons).toEqual(["card_failed"])
  })
})

describe("refusalLike", () => {
  it("refusal_like_conservative", () => {
    for (const s of ["I'm sorry, I can't help with that.", "Sorry, I am unable to do that for you.", "I cannot assist with this request.", "I'm not able to help with that."]) expect(refusalLike(s), s).toBe(true)
    for (const s of ["Your order is on the way.", "Sorry for the wait! Here are the bundles.", "You can't buy below GHS 1, but 1GB costs GHS 5.", "", "I can help with that."]) expect(refusalLike(s), s).toBe(false)
  })
})
