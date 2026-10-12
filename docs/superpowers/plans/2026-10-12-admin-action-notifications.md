# Admin-Action Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alert admins by email + push when a user request needing admin action is created, and message the user by email + SMS when an admin approves/rejects/completes/resolves it, through one central notifier, across six flows.

**Architecture:** A new `lib/admin-actions/` module: a pure, dependency-injected notifier (`createNotifier(registry, deps)`) with per-channel failure isolation, plus one content module per flow (admin alert + per-outcome user message) collected in a registry. Routes call two functions (`alertAdminsOfRequest`, `notifyUserOfOutcome`) after a real state change. Existing inline sends in migrated routes are replaced by those calls.

**Tech Stack:** Next.js route handlers, Supabase service client, existing `email-service` / `sms-service` / `push-service`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-admin-action-notifications-design.md`

## Global Constraints

- No database migration. No change to any route's HTTP response shape or status codes (except the documented `409 already handled` where a status update becomes conditional).
- The notifier functions NEVER throw and are always `await`ed by routes (serverless may freeze fire-and-forget work). A failing/slow channel (8 s timeout) never blocks the others or the request.
- Call `notifyUserOfOutcome` only after the state change actually applied (conditional update returned a row / status differed before). Never on a repeat call.
- Existing user-facing channels in migrated flows are preserved (email/SMS/push/in-app that a user received before they still receive); the notifier is a superset.
- Admin alerts use email + push only (no SMS). User outcome messages use email + SMS (+ the push/in-app a flow already sent).
- All user/admin-supplied text placed in email HTML is escaped (`escapeHtml`); SMS text is clipped to 160 chars (`clipSms`); no secrets, OTPs or full account numbers in any message.
- Log prefix `[ADMIN-ACTION]`. Match surrounding style (no needless comments).
- Work in the existing worktree `C:\Users\User2\.gemini\antigravity-ide\scratch\Datagod2\.claude\worktrees\admin-action-notifications` (branch `feat/admin-action-notifications`, based on `origin/main`; `node_modules` is a junction — create it with `cmd //c "mklink /J node_modules C:\\Users\\User2\\.gemini\\antigravity-ide\\scratch\\Datagod2\\node_modules"` if missing). Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Test baseline: `npm run test:run` has exactly 9 pre-existing failures, all in `lib/order-health-service.test.ts`. Anything else failing is yours.

## Review Focus

- A thrown/slow email or SMS provider must not fail or delay the approve/reject/create request beyond the 8 s channel cap, and must not stop the other channels. (Task 1 tests.)
- A double-click / retry / two admins on the same request must send ONE outcome message, not two (conditional updates in Tasks 3–8).
- User-controlled text (shop names, complaint text, rejection reasons) must never inject HTML into emails. (Tasks 1–2 tests.)
- Guest requests with no account (results-check via WhatsApp/USSD, WhatsApp complaints) must still reach the user by SMS to the request's phone and must not crash on a missing user id/email. (Tasks 1, 6, 8.)
- No admin users / no push subscriptions / SMS credits exhausted must degrade silently (logged), never error the request. (Task 1.)

---

## File Structure

```
lib/admin-actions/
  types.ts          FlowId, Outcome, AdminAlert, UserMessage, Target, ChannelResult, NotifierDeps, FlowDef
  contexts.ts       per-flow context interfaces + FlowCtx map
  html.ts           escapeHtml, appUrl, emailShell, clipSms
  notifier.ts       createNotifier(registry, deps)  — pure, injectable
  default-deps.ts   real wiring (email/sms/push/notifications/users), dynamic imports
  flows/withdrawal.ts, afa.ts, results-check.ts, shop.ts, sender-id.ts, complaint.ts
  registry.ts       FLOWS registry
  index.ts          alertAdminsOfRequest, notifyUserOfOutcome (typed, bound to FLOWS + default deps)
  *.test.ts         unit tests; wiring.test.ts = source-level guards for migrated routes
docs/superpowers/runbooks/admin-action-notifications.md
```

---

### Task 1: Notifier core (types, html helpers, injectable notifier, default deps)

**Files:**
- Create: `lib/admin-actions/types.ts`, `lib/admin-actions/contexts.ts`, `lib/admin-actions/html.ts`, `lib/admin-actions/notifier.ts`, `lib/admin-actions/default-deps.ts`
- Test: `lib/admin-actions/html.test.ts`, `lib/admin-actions/notifier.test.ts`

**Interfaces:**
- Produces: `FlowId`, `Outcome`, `AdminAlert`, `UserMessage`, `Target`, `ChannelResult`, `NotifierDeps`, `FlowDef<C>`; `escapeHtml(v)`, `appUrl(path)`, `emailShell({heading, paragraphs, cta?})`, `clipSms(s, max?)`; `createNotifier(registry, deps)` → `{ alertAdminsOfRequest(flow, ctx), notifyUserOfOutcome(flow, outcome, target, ctx) }`; `getDefaultDeps(): NotifierDeps`; context interfaces + `FlowCtx`.

- [ ] **Step 1: Write `lib/admin-actions/types.ts`**

```ts
export type FlowId = "withdrawal" | "afa" | "results_check" | "shop" | "sender_id" | "complaint"
export type Outcome = "approved" | "rejected" | "completed" | "resolved"

export interface AdminAlert {
  subject: string
  html: string
  pushTitle: string
  pushBody: string
  url: string
}

export interface UserMessage {
  emailSubject: string
  emailHtml: string
  sms: string
  push?: { title: string; body: string; url: string }
  inApp?: { title: string; message: string; type: string; actionUrl?: string }
}

/** Who to tell. Explicit email/phone win over what the user's account has (guest requests have no account). */
export interface Target {
  userId?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
  /** order/request id: used as the SMS/email log reference and the in-app notification reference_id */
  reference?: string
}

export interface Recipient {
  userId: string
  email: string | null
  phone: string | null
  name: string | null
}

export type ChannelName =
  | "admin_email" | "admin_push"
  | "user_email" | "user_sms" | "user_push" | "user_inapp"

export interface ChannelResult {
  channel: ChannelName
  status: "sent" | "skipped" | "failed"
  detail?: string
}

export interface NotifierDeps {
  sendEmail(p: {
    to: { email: string; name?: string }[]
    subject: string
    htmlContent: string
    userId?: string
    referenceId?: string
    type?: string
  }): Promise<unknown>
  sendSMS(p: { phone: string; message: string; type: string; reference?: string }): Promise<unknown>
  sendPushToUser(userId: string, p: { title: string; body: string; data?: Record<string, unknown> }): Promise<unknown>
  notifyAdminsEmail(subject: string, html: string): Promise<void>
  notifyAdminsPush(p: { title: string; body: string; data?: Record<string, unknown> }): Promise<unknown>
  insertNotification(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>
  getRecipient(userId: string): Promise<Recipient | null>
}

export interface FlowDef<C> {
  adminAlert(ctx: C): AdminAlert
  /** null = this flow does not message the user for that outcome */
  userMessage(outcome: Outcome, ctx: C): UserMessage | null
}
```

- [ ] **Step 2: Write `lib/admin-actions/contexts.ts`**

```ts
import type { FlowId } from "./types"

export interface WithdrawalCtx {
  withdrawalId: string
  amount: number
  shopName?: string | null
  method?: string | null
  phone?: string | null
  reason?: string | null
  remainingBalance?: string | null
}
export interface AfaCtx {
  orderCode: string
  fullName: string
  reason?: string | null
}
export interface ResultsCheckCtx {
  requestId: string
  examBoard: string
  indexNumber: string
  examYear?: string | number | null
  channel?: string | null
  shopName?: string | null
  reason?: string | null
}
export interface ShopCtx {
  shopId: string
  shopName: string
  reason?: string | null
}
export interface SenderIdCtx {
  senderIdId: string
  senderId: string
  reason?: string | null
}
export interface ComplaintCtx {
  complaintId: string
  orderId?: string | null
  priority?: string | null
  summary?: string | null
  resolutionNotes?: string | null
}

export interface FlowCtx {
  withdrawal: WithdrawalCtx
  afa: AfaCtx
  results_check: ResultsCheckCtx
  shop: ShopCtx
  sender_id: SenderIdCtx
  complaint: ComplaintCtx
}
export type _FlowCtxKeysMatchFlowId = keyof FlowCtx extends FlowId ? (FlowId extends keyof FlowCtx ? true : never) : never
```

- [ ] **Step 3: Write the failing html test `lib/admin-actions/html.test.ts`**

```ts
import { appUrl, clipSms, emailShell, escapeHtml } from "./html"

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<script>alert("x")&'</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;")
  })
  it("tolerates null/undefined/numbers", () => {
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(undefined)).toBe("")
    expect(escapeHtml(12.5)).toBe("12.5")
  })
})

describe("appUrl", () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL
  afterEach(() => { process.env.NEXT_PUBLIC_APP_URL = prev })
  it("joins base and path with exactly one slash", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/"
    expect(appUrl("/admin/withdrawals")).toBe("https://example.com/admin/withdrawals")
    expect(appUrl("admin/x")).toBe("https://example.com/admin/x")
  })
  it("falls back to the production domain", () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(appUrl("/a")).toBe("https://www.datagod.store/a")
  })
})

describe("emailShell", () => {
  it("escapes heading, paragraphs and cta", () => {
    const html = emailShell({
      heading: "<b>Hi</b>",
      paragraphs: ["<img src=x onerror=alert(1)>", "ok"],
      cta: { label: "Go <now>", url: 'https://x.test/?a="b"' },
    })
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<b>Hi")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("Go &lt;now&gt;")
    expect(html).toContain("https://x.test/?a=&quot;b&quot;")
  })
  it("omits the button when there is no cta", () => {
    expect(emailShell({ heading: "H", paragraphs: ["p"] })).not.toContain("<a ")
  })
})

describe("clipSms", () => {
  it("leaves short text alone", () => expect(clipSms("hello")).toBe("hello"))
  it("clips to 160 chars with ASCII ellipsis", () => {
    const out = clipSms("x".repeat(400))
    expect(out).toHaveLength(160)
    expect(out.endsWith("...")).toBe(true)
  })
  it("honours a custom max", () => expect(clipSms("abcdefghij", 8)).toBe("abcde..."))
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run lib/admin-actions/html.test.ts` — Expected: FAIL (module `./html` not found).

- [ ] **Step 5: Write `lib/admin-actions/html.ts`**

```ts
export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://www.datagod.store").replace(/\/+$/, "")
  return base + (path.startsWith("/") ? path : `/${path}`)
}

/** Plain-text in, safe HTML out: every string is escaped here, callers pass raw text. */
export function emailShell(o: { heading: string; paragraphs: string[]; cta?: { label: string; url: string } }): string {
  const paras = o.paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1f2937">${escapeHtml(p)}</p>`)
    .join("")
  const button = o.cta
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(o.cta.url)}" style="background:#059669;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px;display:inline-block">${escapeHtml(o.cta.label)}</a></p>`
    : ""
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
    `<h2 style="margin:0 0 16px;font-size:20px;color:#111827">${escapeHtml(o.heading)}</h2>` +
    paras +
    button +
    `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">DATAGOD</p>` +
    `</div>`
  )
}

export function clipSms(s: string, max = 160): string {
  return s.length <= max ? s : s.slice(0, max - 3).trimEnd() + "..."
}
```

- [ ] **Step 6: Run html tests**

Run: `npx vitest run lib/admin-actions/html.test.ts` — Expected: PASS.

- [ ] **Step 7: Write the failing notifier test `lib/admin-actions/notifier.test.ts`**

```ts
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
    expect(calls.sms[0]).toEqual({ phone: "0241112222", message: "Approved W1", type: "f_approved", reference: "R1" })
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
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run lib/admin-actions/notifier.test.ts` — Expected: FAIL (module `./notifier` not found).

- [ ] **Step 9: Write `lib/admin-actions/notifier.ts`**

```ts
import type { ChannelName, ChannelResult, FlowDef, NotifierDeps, Outcome, Recipient, Target } from "./types"

const CHANNEL_TIMEOUT_MS = 8000
const LOOKUP_TIMEOUT_MS = 5000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function run(channel: ChannelName, fn: () => Promise<unknown>): Promise<ChannelResult> {
  try {
    await withTimeout(Promise.resolve().then(fn), CHANNEL_TIMEOUT_MS, channel)
    return { channel, status: "sent" }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[ADMIN-ACTION] ${channel} failed: ${detail}`)
    return { channel, status: "failed", detail }
  }
}

const skipped = (channel: ChannelName, detail: string): Promise<ChannelResult> =>
  Promise.resolve({ channel, status: "skipped", detail })

export function createNotifier(registry: Record<string, FlowDef<any>>, deps: NotifierDeps) {
  async function alertAdminsOfRequest(flow: string, ctx: unknown): Promise<ChannelResult[]> {
    try {
      const def = registry[flow]
      if (!def) {
        console.error(`[ADMIN-ACTION] unknown flow "${flow}"`)
        return []
      }
      const alert = def.adminAlert(ctx)
      return await Promise.all([
        run("admin_email", () => deps.notifyAdminsEmail(alert.subject, alert.html)),
        run("admin_push", () => deps.notifyAdminsPush({ title: alert.pushTitle, body: alert.pushBody, data: { url: alert.url } })),
      ])
    } catch (err) {
      console.error(`[ADMIN-ACTION] alert for "${flow}" failed:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  async function notifyUserOfOutcome(flow: string, outcome: Outcome, target: Target, ctx: unknown): Promise<ChannelResult[]> {
    try {
      const msg = registry[flow]?.userMessage(outcome, ctx)
      if (!msg) return []

      let rcpt: Recipient | null = null
      if (target.userId) {
        try {
          rcpt = await withTimeout(deps.getRecipient(target.userId), LOOKUP_TIMEOUT_MS, "getRecipient")
        } catch (err) {
          console.error("[ADMIN-ACTION] recipient lookup failed:", err instanceof Error ? err.message : err)
        }
      }
      const email = target.email ?? rcpt?.email ?? null
      const phone = target.phone ?? rcpt?.phone ?? null
      const name = target.name ?? rcpt?.name ?? undefined
      const type = `${flow}_${outcome}`
      const reference = target.reference
      const userId = target.userId ?? undefined

      const jobs: Promise<ChannelResult>[] = [
        email
          ? run("user_email", () =>
              deps.sendEmail({ to: [{ email, name }], subject: msg.emailSubject, htmlContent: msg.emailHtml, userId, referenceId: reference, type }),
            )
          : skipped("user_email", "no email"),
        phone
          ? run("user_sms", () => deps.sendSMS({ phone, message: msg.sms, type, reference }))
          : skipped("user_sms", "no phone"),
      ]
      if (msg.push) {
        const push = msg.push
        jobs.push(
          userId
            ? run("user_push", () => deps.sendPushToUser(userId, { title: push.title, body: push.body, data: { url: push.url } }))
            : skipped("user_push", "no account"),
        )
      }
      if (msg.inApp) {
        const inApp = msg.inApp
        jobs.push(
          userId
            ? run("user_inapp", async () => {
                const { error } = await deps.insertNotification({
                  user_id: userId,
                  title: inApp.title,
                  message: inApp.message,
                  type: inApp.type,
                  reference_id: reference ?? null,
                  action_url: inApp.actionUrl ?? null,
                  read: false,
                })
                if (error) throw new Error(error.message)
              })
            : skipped("user_inapp", "no account"),
        )
      }
      return await Promise.all(jobs)
    } catch (err) {
      console.error(`[ADMIN-ACTION] outcome "${flow}/${outcome}" failed:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  return { alertAdminsOfRequest, notifyUserOfOutcome }
}
```

- [ ] **Step 10: Run notifier tests**

Run: `npx vitest run lib/admin-actions` — Expected: PASS (html + notifier).

- [ ] **Step 11: Write `lib/admin-actions/default-deps.ts`** (real wiring; dynamic imports keep unit tests light)

```ts
import type { NotifierDeps, Recipient } from "./types"

async function db() {
  const { supabaseAdmin } = await import("@/lib/supabase")
  return supabaseAdmin
}

export function getDefaultDeps(): NotifierDeps {
  return {
    async sendEmail(p) {
      const { sendEmail } = await import("@/lib/email-service")
      const r = await sendEmail(p)
      if (r && r.success === false) throw new Error(r.error || "email send failed")
      return r
    },
    async sendSMS(p) {
      const { sendSMS } = await import("@/lib/sms-service")
      const r = await sendSMS(p)
      if (r && r.success === false && !r.skipped) throw new Error(r.error || "sms send failed")
      return r
    },
    async sendPushToUser(userId, p) {
      const { sendPushToUser } = await import("@/lib/push-service")
      return sendPushToUser(userId, p)
    },
    async notifyAdminsEmail(subject, html) {
      const { notifyAdmins } = await import("@/lib/email-service")
      await notifyAdmins(subject, html)
    },
    async notifyAdminsPush(p) {
      const { notifyAdminsPush } = await import("@/lib/push-service")
      return notifyAdminsPush(p)
    },
    async insertNotification(row) {
      const client = await db()
      const { error } = await client.from("notifications").insert([row])
      return { error: error ? { message: error.message } : null }
    },
    async getRecipient(userId): Promise<Recipient | null> {
      const client = await db()
      const { data, error } = await client.from("users").select("email, phone_number, first_name").eq("id", userId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return null
      return { userId, email: data.email ?? null, phone: data.phone_number ?? null, name: data.first_name ?? null }
    },
  }
}
```

- [ ] **Step 12: Typecheck and commit**

Run: `npx tsc --noEmit -p .` — no errors in `lib/admin-actions/**`. (If `supabaseAdmin` is not exported from `@/lib/supabase`, use the export `lib/push-service.ts` already imports for its service-role client.)

```bash
git add lib/admin-actions
git commit -m "feat(admin-actions): injectable notifier core with per-channel isolation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Flow content modules and registry

**Files:**
- Create: `lib/admin-actions/flows/{withdrawal,afa,results-check,shop,sender-id,complaint}.ts`, `lib/admin-actions/registry.ts`, `lib/admin-actions/index.ts`
- Test: `lib/admin-actions/flows.test.ts`

**Interfaces:**
- Consumes: Task 1 types/helpers/contexts.
- Produces: `FLOWS: Record<FlowId, FlowDef<any>>`; `alertAdminsOfRequest<F>(flow, ctx)` and `notifyUserOfOutcome<F>(flow, outcome, target, ctx)` (typed by `FlowCtx`, bound to `FLOWS` + `getDefaultDeps()`).

Wording rule: where a migrated flow already has wording (withdrawals, shops), **read it first and reuse its text**: `lib/email-service.ts` `EmailTemplates.withdrawalApproved/withdrawalRejected/shopApproved/shopRejected` (lines ~375–510), `lib/notification-service.ts` `notificationTemplates.*` (in-app title/message), and the inline SMS strings in the routes. Do NOT import those modules into the flow files (they pull in heavy clients); copy the sentences into the new templates built with `emailShell`.

- [ ] **Step 1: Write the failing table-driven test `lib/admin-actions/flows.test.ts`**

```ts
import { FLOWS } from "./registry"
import type { FlowId, Outcome } from "./types"

const EVIL = `<script>alert(1)</script>`
const LONG = "very long text ".repeat(40)

const ctxFor: Record<FlowId, any> = {
  withdrawal: { withdrawalId: "w1", amount: 120.5, shopName: EVIL, method: "Mobile Money", phone: "0241112222", reason: EVIL + LONG, remainingBalance: "10.00" },
  afa: { orderCode: "AFA-123", fullName: EVIL, reason: EVIL + LONG },
  results_check: { requestId: "r1", examBoard: "WASSCE", indexNumber: "1234567890", examYear: 2025, channel: "web", shopName: EVIL, reason: EVIL + LONG },
  shop: { shopId: "s1", shopName: EVIL, reason: EVIL + LONG },
  sender_id: { senderIdId: "x1", senderId: EVIL, reason: EVIL + LONG },
  complaint: { complaintId: "c1", orderId: "o1", priority: "high", summary: EVIL + LONG, resolutionNotes: EVIL + LONG },
}
const SUPPORTED: Record<FlowId, Outcome[]> = {
  withdrawal: ["approved", "rejected", "completed"],
  afa: ["completed", "rejected"],
  results_check: ["completed", "rejected"],
  shop: ["approved", "rejected"],
  sender_id: ["approved", "rejected"],
  complaint: ["resolved", "rejected"],
}
const ALL: Outcome[] = ["approved", "rejected", "completed", "resolved"]

describe.each(Object.keys(FLOWS) as FlowId[])("flow %s", (flow) => {
  const def = FLOWS[flow]
  it("admin alert has a subject, push text and an /admin deep link, with escaped html", () => {
    const a = def.adminAlert(ctxFor[flow])
    expect(a.subject.length).toBeGreaterThan(5)
    expect(a.pushTitle.length).toBeGreaterThan(2)
    expect(a.pushBody.length).toBeGreaterThan(0)
    expect(a.url.startsWith("/admin/")).toBe(true)
    expect(a.html).not.toContain("<script>")
  })
  it.each(ALL)("outcome %s is supported or null as declared", (outcome) => {
    const m = def.userMessage(outcome, ctxFor[flow])
    if (!SUPPORTED[flow].includes(outcome)) {
      expect(m).toBeNull()
      return
    }
    expect(m).not.toBeNull()
    expect(m!.emailSubject.length).toBeGreaterThan(5)
    expect(m!.emailHtml).not.toContain("<script>")
    expect(m!.sms.length).toBeLessThanOrEqual(160)
    expect(m!.sms.length).toBeGreaterThan(10)
  })
  it("rejection messages carry the admin's reason (clipped in SMS) and fall back gracefully without one", () => {
    const withReason = def.userMessage("rejected", { ...ctxFor[flow], reason: "Bad number", resolutionNotes: "Bad number" })
    expect(withReason!.emailHtml).toContain("Bad number")
    const without = def.userMessage("rejected", { ...ctxFor[flow], reason: undefined, resolutionNotes: undefined })
    expect(without!.sms.length).toBeGreaterThan(10)
  })
  it("never leaks the literal 'undefined' or 'null' into messages", () => {
    const sparse: any = { ...ctxFor[flow] }
    for (const k of Object.keys(sparse)) if (!/id$|Id$|code$|Code$|amount|board|index|name|summary/i.test(k)) delete sparse[k]
    for (const o of SUPPORTED[flow]) {
      const m = def.userMessage(o, sparse)!
      expect(m.sms).not.toMatch(/undefined|null|NaN/)
      expect(m.emailHtml).not.toMatch(/undefined|null|NaN/)
    }
  })
})

describe("withdrawal specifics", () => {
  it("approved keeps push + in-app (existing channels preserved) and shows the amount", () => {
    const m = FLOWS.withdrawal.userMessage("approved", { withdrawalId: "w1", amount: 120.5 })!
    expect(m.sms).toContain("GHS 120.50")
    expect(m.push?.url).toBe("/dashboard/shop-dashboard")
    expect(m.inApp?.type).toBe("withdrawal_approved")
  })
  it("rejected in-app uses the existing withdrawal_rejected type", () => {
    expect(FLOWS.withdrawal.userMessage("rejected", { withdrawalId: "w1", amount: 5 })!.inApp?.type).toBe("withdrawal_rejected")
  })
})
describe("shop specifics", () => {
  it("approved keeps push + in-app", () => {
    const m = FLOWS.shop.userMessage("approved", { shopId: "s", shopName: "Kofi Data" })!
    expect(m.push).toBeDefined()
    expect(m.inApp).toBeDefined()
    expect(m.sms).toContain("approved")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/admin-actions/flows.test.ts` — Expected: FAIL (`./registry` not found).

- [ ] **Step 3: Write the six flow modules.** Each exports a `FlowDef<Ctx>` built only from `emailShell`, `appUrl`, `clipSms`; all interpolated text goes through the shell (which escapes). Helper in each file: `const money = (n: number) => \`GHS ${Number(n).toFixed(2)}\`` where amounts appear. Build optional fragments with arrays + `filter(Boolean)` so nothing prints `undefined`.

`lib/admin-actions/flows/withdrawal.ts`

```ts
import type { WithdrawalCtx } from "../contexts"
import { appUrl, clipSms, emailShell } from "../html"
import type { FlowDef, Outcome, UserMessage } from "../types"

const money = (n: number) => `GHS ${Number(n).toFixed(2)}`
const OWNER_URL = "/dashboard/shop-dashboard"
const details = (c: WithdrawalCtx) =>
  [c.method ? `Method: ${c.method}` : "", c.phone ? `To: ${c.phone}` : ""].filter(Boolean)

export const withdrawalFlow: FlowDef<WithdrawalCtx> = {
  adminAlert(c) {
    const from = c.shopName ? ` from ${c.shopName}` : ""
    return {
      subject: `New withdrawal request: ${money(c.amount)}`,
      html: emailShell({
        heading: "New withdrawal request",
        paragraphs: [`A withdrawal request of ${money(c.amount)}${from} is waiting for approval.`, ...details(c)],
        cta: { label: "Review withdrawals", url: appUrl("/admin/withdrawals") },
      }),
      pushTitle: "New withdrawal request",
      pushBody: `${money(c.amount)}${from}`,
      url: "/admin/withdrawals",
    }
  },
  userMessage(outcome: Outcome, c): UserMessage | null {
    const bal = c.remainingBalance ? [`Remaining balance: GHS ${c.remainingBalance}`] : []
    if (outcome === "approved") {
      return {
        emailSubject: `Withdrawal approved: ${money(c.amount)}`,
        emailHtml: emailShell({
          heading: "Withdrawal approved",
          paragraphs: [`Your withdrawal request of ${money(c.amount)} has been approved and is being processed.`, ...details(c), ...bal],
          cta: { label: "Open dashboard", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms(`Your withdrawal of ${money(c.amount)} has been approved and is being processed.`),
        push: { title: "Withdrawal approved", body: `Your withdrawal of ${money(c.amount)} was approved.`, url: OWNER_URL },
        inApp: { title: "Withdrawal approved", message: `Your withdrawal request of ${money(c.amount)} has been approved.`, type: "withdrawal_approved", actionUrl: OWNER_URL },
      }
    }
    if (outcome === "rejected") {
      const why = c.reason ? [`Reason: ${c.reason}`] : []
      return {
        emailSubject: `Withdrawal rejected: ${money(c.amount)}`,
        emailHtml: emailShell({
          heading: "Withdrawal rejected",
          paragraphs: [`Your withdrawal request of ${money(c.amount)} has been rejected.`, ...why, ...bal, "Contact support if you need help."],
          cta: { label: "Open dashboard", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms(`Your withdrawal request of ${money(c.amount)} has been rejected.${c.reason ? ` Reason: ${c.reason}.` : ""} Contact support for assistance.`),
        push: { title: "Withdrawal rejected", body: `Your withdrawal of ${money(c.amount)} was rejected.`, url: OWNER_URL },
        inApp: { title: "Withdrawal rejected", message: `Your withdrawal request of ${money(c.amount)} was rejected.${c.reason ? ` Reason: ${c.reason}` : ""}`, type: "withdrawal_rejected", actionUrl: OWNER_URL },
      }
    }
    if (outcome === "completed") {
      return {
        emailSubject: `Withdrawal paid out: ${money(c.amount)}`,
        emailHtml: emailShell({
          heading: "Withdrawal paid out",
          paragraphs: [`Your withdrawal of ${money(c.amount)} has been paid out.`, ...details(c)],
          cta: { label: "Open dashboard", url: appUrl(OWNER_URL) },
        }),
        sms: clipSms(`Your withdrawal of ${money(c.amount)} has been paid out.`),
        inApp: { title: "Withdrawal paid out", message: `Your withdrawal of ${money(c.amount)} has been paid out.`, type: "balance_updated", actionUrl: OWNER_URL },
      }
    }
    return null
  },
}
```

The other five follow the same pattern. Required content (write each with the same structure; admin `url` and supported outcomes as given):

| File / export | Admin alert (subject · push body · url) | Outcomes → user message |
|---|---|---|
| `afa.ts` `afaFlow` | `New AFA registration: <orderCode>` · `<fullName> (<orderCode>)` · `/admin/afa-registrations` | `completed`: SMS `AFA registration <orderCode> for <fullName> is complete.`; `rejected`: `AFA registration <orderCode> for <fullName> has been cancelled.` + ` Reason: …` if any + contact-support line |
| `results-check.ts` `resultsCheckFlow` | `New results check request: <examBoard>` · `<examBoard> · index <indexNumber>` · `/admin/results-check-requests` (body also mentions `<channel>`/`<shopName>` when present) | `completed`: `Your <examBoard> results check (index <indexNumber>) is ready - we have sent the result to you.`; `rejected`: `...could not be completed.` + reason |
| `shop.ts` `shopFlow` | `New shop awaiting approval: <shopName>` · `<shopName>` · `/admin/shops` | `approved`: reuse the existing sentence `Congratulations! Your shop has been approved. You can now start selling.` (SMS keeps the `DTGOD:` prefix and `www.datagod.store`), with push + in-app (`type` as the existing approve route uses, url `/dashboard/shop-dashboard`); `rejected`: existing rejection wording + reason, with push + in-app |
| `sender-id.ts` `senderIdFlow` | `New SMS sender ID request: <senderId>` · `<senderId>` · confirm the real admin page for sender IDs with `grep -rln "sender" app/admin` and use it (`/admin/sms-centre` if it is the sender-ID page) | `approved`: `Your SMS sender ID "<senderId>" has been approved. You can now send messages with it.`; `rejected`: `...was not approved.` + reason |
| `complaint.ts` `complaintFlow` | `New <priority> complaint` · `<summary clipped to 80 chars>` · `/admin/complaints` | `resolved`: `Your complaint has been resolved.` + resolution notes (clipped); `rejected`: `Your complaint has been closed without action.` + notes |

Rules for all: `completed`/`resolved`/`approved` with no matching outcome for a flow return `null` (exactly the `SUPPORTED` map in the test); SMS built with `clipSms`; every dynamic value passed to `emailShell` as plain text; no `undefined` strings (build optional pieces conditionally).

- [ ] **Step 4: Write `lib/admin-actions/registry.ts`**

```ts
import { afaFlow } from "./flows/afa"
import { complaintFlow } from "./flows/complaint"
import { resultsCheckFlow } from "./flows/results-check"
import { senderIdFlow } from "./flows/sender-id"
import { shopFlow } from "./flows/shop"
import { withdrawalFlow } from "./flows/withdrawal"
import type { FlowDef, FlowId } from "./types"

export const FLOWS: Record<FlowId, FlowDef<any>> = {
  withdrawal: withdrawalFlow,
  afa: afaFlow,
  results_check: resultsCheckFlow,
  shop: shopFlow,
  sender_id: senderIdFlow,
  complaint: complaintFlow,
}
```

- [ ] **Step 5: Write `lib/admin-actions/index.ts`**

```ts
import type { FlowCtx } from "./contexts"
import { getDefaultDeps } from "./default-deps"
import { createNotifier } from "./notifier"
import { FLOWS } from "./registry"
import type { ChannelResult, FlowId, Outcome, Target } from "./types"

export type { Outcome, Target, ChannelResult, FlowId } from "./types"

/** Email + push to every admin. Never throws. Await it. */
export function alertAdminsOfRequest<F extends FlowId>(flow: F, ctx: FlowCtx[F]): Promise<ChannelResult[]> {
  return createNotifier(FLOWS, getDefaultDeps()).alertAdminsOfRequest(flow, ctx)
}

/** Email + SMS (+ push/in-app where the flow had them) to the user. Never throws. Await it. Call only after the state change applied. */
export function notifyUserOfOutcome<F extends FlowId>(flow: F, outcome: Outcome, target: Target, ctx: FlowCtx[F]): Promise<ChannelResult[]> {
  return createNotifier(FLOWS, getDefaultDeps()).notifyUserOfOutcome(flow, outcome, target, ctx)
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run lib/admin-actions` — Expected: PASS. `npx tsc --noEmit -p .` — clean for `lib/admin-actions/**`.

- [ ] **Step 7: Commit**

```bash
git add lib/admin-actions
git commit -m "feat(admin-actions): flow templates and registry for six admin-action flows

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Withdrawals wiring

**Files:**
- Modify: `app/api/user/withdrawals/create/route.ts`, `app/api/admin/withdrawals/approve/route.ts`, `app/api/admin/withdrawals/bulk-approve/route.ts`, `app/api/admin/withdrawals/reject/route.ts`, `app/api/admin/withdrawals/complete/route.ts`, `app/api/admin/withdrawals/submit-transfer-otp/route.ts`, `app/api/cron/withdrawals-status-check/route.ts`
- Create: `lib/admin-actions/wiring.test.ts`

**Interfaces:**
- Consumes: `alertAdminsOfRequest`, `notifyUserOfOutcome` from `@/lib/admin-actions`.

Facts (verified): the create route calls `withdrawalService.createWithdrawalRequest(...)` then returns `{success, withdrawal: created}`; the shop lookup selects `"id, user_id"`. `approve/route.ts` has `async function notifyShopOwner(withdrawal, withdrawalId)` (≈lines 50–130: in-app + push + email with balance + SMS) called from 5 success points; `bulk-approve/route.ts` has `notifyOwner(shopId, amount, withdrawalId, succeeded)` (≈32–62) called at 4 points (3× `true`, 1× `false` for a failed transfer). `reject/route.ts` has an inline block "Send notification to shop owner via admin API endpoint" (≈lines 69–170) after an UNCONDITIONAL status update. `complete/route.ts` updates to `completed` at ≈line 45 with no notification.

- [ ] **Step 1: Create route-wiring guards `lib/admin-actions/wiring.test.ts`** (source-level checks; extended by later tasks)

```ts
import { readFileSync } from "node:fs"
import path from "node:path"

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8").replace(/\r\n/g, "\n")

describe("withdrawals wiring", () => {
  it("create route alerts admins once", () => {
    const src = read("app/api/user/withdrawals/create/route.ts")
    expect(src.match(/alertAdminsOfRequest\("withdrawal"/g)).toHaveLength(1)
  })
  it("approve route notifies via the central notifier and no longer sends inline email/sms for approval", () => {
    const src = read("app/api/admin/withdrawals/approve/route.ts")
    expect(src).toContain('notifyUserOfOutcome("withdrawal", "approved"')
    expect(src).not.toContain("type: 'withdrawal_approved'")
    expect(src).not.toContain("notificationTemplates.withdrawalApproved")
  })
  it("bulk-approve success path uses the central notifier", () => {
    const src = read("app/api/admin/withdrawals/bulk-approve/route.ts")
    expect(src).toContain('notifyUserOfOutcome("withdrawal", "approved"')
  })
  it("reject route uses the central notifier and a conditional update", () => {
    const src = read("app/api/admin/withdrawals/reject/route.ts")
    expect(src).toContain('notifyUserOfOutcome("withdrawal", "rejected"')
    expect(src).not.toContain("type: 'withdrawal_rejected'")
    expect(src).not.toContain("notificationTemplates.withdrawalRejected")
    expect(src).toMatch(/\.in\("status", rejectableStatuses\)/)
  })
  it("complete route, transfer-otp route and status cron notify 'completed'", () => {
    for (const f of [
      "app/api/admin/withdrawals/complete/route.ts",
      "app/api/admin/withdrawals/submit-transfer-otp/route.ts",
      "app/api/cron/withdrawals-status-check/route.ts",
    ]) {
      expect(read(f)).toContain('notifyUserOfOutcome("withdrawal", "completed"')
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/admin-actions/wiring.test.ts` — Expected: FAIL.

- [ ] **Step 3: Create route** — in `app/api/user/withdrawals/create/route.ts`:
  1. add `import { alertAdminsOfRequest } from "@/lib/admin-actions"`;
  2. change the shop lookup `.select("id, user_id")` → `.select("id, user_id, shop_name")`;
  3. after `const created = await withdrawalService.createWithdrawalRequest(...)` and before `return NextResponse.json({ success: true, ... })` insert:

```ts
    await alertAdminsOfRequest("withdrawal", {
      withdrawalId: String((created as { id?: string } | null)?.id ?? ""),
      amount,
      shopName: shop.shop_name ?? null,
      method: withdrawal_method,
    })
```
  (Confirm `created` carries `id`; if `createWithdrawalRequest` returns an array/other shape, read `lib/shop-service.ts` and adapt the access — the alert must not fail if the id is absent.)

- [ ] **Step 4: Approve route** — replace the **body** of `notifyShopOwner(withdrawal, withdrawalId)` (keep its name, signature and all 5 call sites untouched). New body:

```ts
async function notifyShopOwner(withdrawal: any, withdrawalId: string) {
  try {
    const { data: shop } = await supabase.from("user_shops").select("user_id, shop_name").eq("id", withdrawal.shop_id).single()
    if (!shop) return
    const { data: bal } = await supabase.from("shop_available_balance").select("available_balance").eq("shop_id", withdrawal.shop_id).single()
    const details = (withdrawal.account_details ?? {}) as any
    await notifyUserOfOutcome(
      "withdrawal",
      "approved",
      { userId: shop.user_id, reference: withdrawalId },
      {
        withdrawalId,
        amount: Number(withdrawal.amount),
        shopName: shop.shop_name ?? null,
        method: withdrawal.withdrawal_method || details?.network || null,
        phone: details?.account_number || null,
        remainingBalance: bal?.available_balance != null ? Number(bal.available_balance).toFixed(2) : null,
      },
    )
  } catch (err) {
    console.warn("[ADMIN-ACTION] withdrawal approval notify failed:", err instanceof Error ? err.message : err)
  }
}
```
  Add `import { notifyUserOfOutcome } from "@/lib/admin-actions"`. Before replacing, read the old body (lines ≈50–130) and confirm everything it sent (in-app via `notificationTemplates.withdrawalApproved`, push, email with remaining balance/method/phone, SMS) is now covered by the `withdrawal/approved` template (email, SMS, push, in-app). Remove imports that become unused (`sendSMS`, `sendPushToUser`, `notificationTemplates`) only if nothing else in the file uses them — check with grep. The manual-approval path (`approved`, manual transfer) calls the same helper, so those users now also get it exactly as before.

- [ ] **Step 5: Bulk-approve** — in `notifyOwner(shopId, amount, withdrawalId, succeeded)`: keep the `succeeded === false` branch **exactly as it is today** (a failed transfer reset to pending is neither approved nor rejected). Replace only the `succeeded === true` behaviour (in-app + push) with the same `notifyUserOfOutcome("withdrawal", "approved", { userId: shop.user_id, reference: withdrawalId }, { withdrawalId, amount, shopName })` call (look up `shop_name` along with `user_id`). Add the import.

- [ ] **Step 6: Reject route** — (a) make the update conditional: add `.in("status", rejectableStatuses).select("id")` to the `update({status: "rejected", ...})` chain; if it returns no row, `return NextResponse.json({ error: "Withdrawal was already handled" }, { status: 409 })` (before notifying); (b) replace the whole block from `// Send notification to shop owner via admin API endpoint` to the end of its enclosing `try/catch` (≈lines 69–170, covering in-app, push, email, SMS) with:

```ts
    try {
      const { data: shop } = await supabase.from("user_shops").select("user_id, shop_name").eq("id", withdrawal.shop_id).single()
      if (shop) {
        const { data: bal } = await supabase.from("shop_available_balance").select("available_balance").eq("shop_id", withdrawal.shop_id).single()
        const details = (withdrawal.account_details ?? {}) as any
        await notifyUserOfOutcome(
          "withdrawal",
          "rejected",
          { userId: shop.user_id, reference: withdrawalId },
          {
            withdrawalId,
            amount: Number(withdrawal.amount),
            shopName: shop.shop_name ?? null,
            method: withdrawal.withdrawal_method || details?.network || null,
            phone: details?.account_number || null,
            reason: reason || "No reason provided",
            remainingBalance: bal?.available_balance != null ? Number(bal.available_balance).toFixed(2) : null,
          },
        )
      }
    } catch (notifError) {
      console.warn("[ADMIN-ACTION] withdrawal rejection notify failed:", notifError instanceof Error ? notifError.message : notifError)
    }
```
  Keep everything after the block (balance resync etc.) unchanged. Add the import; drop unused imports after grepping.

- [ ] **Step 7: Complete / OTP / cron** — in each, immediately after the update that moves the row to `completed` **and only when it actually changed state** (make the update conditional on the pre-state, e.g. `.in("status", [<the statuses that route already allows>]).select("id, shop_id, amount")`, and notify only if a row came back), add:

```ts
await notifyWithdrawalCompleted(row)   // local helper per file, or inline:
// shop lookup (user_id, shop_name) then:
await notifyUserOfOutcome("withdrawal", "completed", { userId: shop.user_id, reference: row.id }, { withdrawalId: row.id, amount: Number(row.amount), shopName: shop.shop_name ?? null })
```
  Put the shared lookup+call in one small helper `lib/admin-actions/withdrawal-hook.ts` (`notifyWithdrawalCompleted(db, row)`) used by the three routes, and unit-test it with a fake db + fake notifier module (`vi.mock("@/lib/admin-actions")`). In `app/api/cron/withdrawals-status-check/route.ts` there are two `status: "completed"` writes (≈lines 173 and 216): notify at both, once per row that the cron actually flipped from `processing`. Then grep for any other writer of `withdrawal_requests.status = 'completed'` (`grep -rn "withdrawal_requests" app lib --include=*.ts`) and cover it the same way or record why it is not user-visible.

- [ ] **Step 8: Run tests, typecheck, commit**

Run: `npx vitest run lib/admin-actions` — PASS (wiring + hook tests). `npx tsc --noEmit -p .` — clean for touched files. Full suite: only the 9 baseline failures.

```bash
git add app/api lib/admin-actions
git commit -m "feat(admin-actions): withdrawals alert admins and notify users via central notifier

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Shop approvals wiring

**Files:**
- Modify: `app/api/shop/create/route.ts`, `app/api/admin/shops/approve/route.ts`, `app/api/admin/shops/reject/route.ts`
- Modify: `lib/admin-actions/wiring.test.ts`

Facts (verified): shops are created by `app/api/shop/create/route.ts` (service-role insert, `is_active` forced `false` until an admin approves). `approve/route.ts` sets `is_active: true` via `.update(...).eq("id", shopId).select("*, user_id")` then has an inline notification block (in-app, push, email `EmailTemplates.shopApproved`, SMS "DTGOD: Congratulations! ..."). `reject/route.ts` has the equivalent with `shopRejected` (≈line 50 onward).

- [ ] **Step 1: Add failing guards to `wiring.test.ts`**

```ts
describe("shop approvals wiring", () => {
  it("create route alerts admins once", () => {
    expect(read("app/api/shop/create/route.ts").match(/alertAdminsOfRequest\("shop"/g)).toHaveLength(1)
  })
  it("approve and reject use the central notifier, not inline sends", () => {
    const a = read("app/api/admin/shops/approve/route.ts")
    expect(a).toContain('notifyUserOfOutcome("shop", "approved"')
    expect(a).not.toContain("type: 'shop_approved'")
    const r = read("app/api/admin/shops/reject/route.ts")
    expect(r).toContain('notifyUserOfOutcome("shop", "rejected"')
    expect(r).not.toContain("type: 'shop_rejected'")
  })
})
```
Run: `npx vitest run lib/admin-actions/wiring.test.ts` — Expected: FAIL for the new block.

- [ ] **Step 2: Create route** — after the successful insert (find the response that returns the new shop) add `await alertAdminsOfRequest("shop", { shopId: <new row id>, shopName: <name> })` (import from `@/lib/admin-actions`); skip it if the row is created already active.

- [ ] **Step 3: Approve** — the update must apply only to a not-yet-active shop: add `.eq("is_active", false)` to the update chain (keep `.select("*, user_id")`); if no row returns, respond with the route's existing "not found" style error code `409` `{ error: "Shop already approved" }` and notify nothing. Replace the entire inline notification block (in-app, push, email, SMS) with:

```ts
    try {
      const shop = data?.[0]
      if (shop?.user_id) {
        await notifyUserOfOutcome("shop", "approved", { userId: shop.user_id, reference: shopId }, { shopId, shopName: shop.shop_name || "Your shop" })
      }
    } catch (e) {
      console.warn("[ADMIN-ACTION] shop approval notify failed:", e instanceof Error ? e.message : e)
    }
```
  Preserve the existing sentences (read them first) in `lib/admin-actions/flows/shop.ts` if Task 2's copy drifted. Same treatment in `reject/route.ts` with outcome `rejected` and `reason` from the request body (the route already reads one). Drop now-unused imports after grep.

- [ ] **Step 4: Tests, typecheck, commit** (`npx vitest run lib/admin-actions`, tsc, full suite baseline)

```bash
git add app/api lib/admin-actions
git commit -m "feat(admin-actions): shop approvals alert admins and notify owners via central notifier

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: AFA registrations wiring

**Files:**
- Modify: `lib/afa-fulfillment.ts` (`submitAfaOrder`, `fulfillAfaOrder`), `app/api/admin/afa-update-status/route.ts`
- Modify: `lib/admin-actions/wiring.test.ts`

Facts (verified): `afa_orders` rows are created only inside `submitAfaOrder` (shared by `app/api/afa/submit` and `app/api/v1/afa`), which then fires auto-fulfilment if `isAfaAutoFulfillmentEnabled()`. The admin route `afa-update-status` selects `"status, full_name, phone_number, order_code"`, updates status, and sends `SMSTemplates.afaCompleted` when status becomes `completed`. `fulfillAfaOrder` sets `status: "completed"` on provider success (≈line 227). The registrant's phone (`phone_number`) is the SMS target today.

- [ ] **Step 1: Failing guards**

```ts
describe("afa wiring", () => {
  it("creation alerts admins once, only when not auto-fulfilling", () => {
    const src = read("lib/afa-fulfillment.ts")
    expect(src.match(/alertAdminsOfRequest\("afa"/g)).toHaveLength(1)
  })
  it("admin status route uses the central notifier", () => {
    const src = read("app/api/admin/afa-update-status/route.ts")
    expect(src).toContain('notifyUserOfOutcome("afa"')
    expect(src).not.toContain("SMSTemplates.afaCompleted")
  })
  it("fulfilment success notifies completed", () => {
    expect(read("lib/afa-fulfillment.ts")).toContain('notifyUserOfOutcome("afa", "completed"')
  })
})
```

- [ ] **Step 2: Creation hook** — in `submitAfaOrder`, in the block where `const autoFulfill = await isAfaAutoFulfillmentEnabled()` is evaluated, add the alert **only in the manual case**:

```ts
    if (!autoFulfill) {
      await alertAdminsOfRequest("afa", { orderCode, fullName })
    }
```
  (If the try block's structure makes that awkward, evaluate `autoFulfill` into a variable first. The alert must never throw into the order flow — it already cannot.) Import from `@/lib/admin-actions` (check the import does not create a cycle with `lib/sms-service`; it lazy-loads services so it should not).

- [ ] **Step 2b: Auto-fulfilment failure also needs an admin** — in `fulfillAfaOrder`, where it records a failed provider attempt (`fulfillment_status: "failed"`, ≈lines 100/164/242), add `await alertAdminsOfRequest("afa", { orderCode: <order code>, fullName: <name> })` **only if** the order is then left for manual handling (status stays `pending`/`processing`); read those branches and apply once per failed attempt, not per retry loop iteration.

- [ ] **Step 3: Outcome hooks** — `afa-update-status/route.ts`: add `user_id` to the select; replace the `sendSMS(... SMSTemplates.afaCompleted ...)` block with

```ts
    if (status !== currentOrder.status && (status === "completed" || status === "cancelled")) {
      await notifyUserOfOutcome(
        "afa",
        status === "completed" ? "completed" : "rejected",
        { userId: currentOrder.user_id, phone: currentOrder.phone_number, reference: submissionId },
        { orderCode: currentOrder.order_code, fullName: currentOrder.full_name },
      )
    }
```
  (the registrant's `phone_number` stays the SMS target; the account email gets the email). In `fulfillAfaOrder`, after the DB write that sets `status: "completed"` succeeds **and the previous status was not completed**, add the same `completed` call (user id from the order row).

- [ ] **Step 4: Tests, typecheck, commit**

```bash
git add lib app/api
git commit -m "feat(admin-actions): AFA registrations alert admins and notify users via central notifier

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Results-check requests wiring

**Files:**
- Modify: `lib/results-checker-service.ts` (`notifyAdminsNewResultsCheckRequest`, `deliverResultsCheckRequest`), `app/api/admin/results-check-requests/route.ts` (PATCH)
- Modify: `lib/admin-actions/wiring.test.ts`

Facts (verified): requests are created by three callers that all call `notifyAdminsNewResultsCheckRequest(requestId)` (`app/api/webhooks/paystack/route.ts` ≈889, `lib/results-checker-service.ts` ≈976, `lib/ussd/handlers/results-checker.ts` ≈898). That function currently returns early when no admin WhatsApp phones are configured, then WhatsApps them. Requests are often **guests** (phone only): the row has `phone_number`, `shop_id`, `exam_board`, `index_number`, `exam_year`, `channel`, `payment_reference`. `deliverResultsCheckRequest` ends by updating the row to `status: "completed"` (≈line 437). The admin `PATCH` route updates a request by id with an `updatePayload`.

- [ ] **Step 1: Failing guards**

```ts
describe("results-check wiring", () => {
  it("admin alert is sent before the WhatsApp early return", () => {
    const src = read("lib/results-checker-service.ts")
    const fn = src.slice(src.indexOf("export async function notifyAdminsNewResultsCheckRequest"))
    const alertAt = fn.indexOf('alertAdminsOfRequest("results_check"')
    const earlyReturnAt = fn.indexOf("phones.length === 0")
    expect(alertAt).toBeGreaterThan(-1)
    expect(earlyReturnAt === -1 || alertAt < earlyReturnAt).toBe(true)
  })
  it("completion and rejection notify the user", () => {
    expect(read("lib/results-checker-service.ts")).toContain('notifyUserOfOutcome("results_check", "completed"')
    expect(read("app/api/admin/results-check-requests/route.ts")).toContain('notifyUserOfOutcome("results_check"')
  })
})
```

- [ ] **Step 2: Admin alert** — restructure `notifyAdminsNewResultsCheckRequest(requestId)`: fetch the request row and shop name **first**, then `await alertAdminsOfRequest("results_check", { requestId, examBoard: req.exam_board, indexNumber: req.index_number, examYear: req.exam_year, channel: <channelLabel>, shopName })`, **then** run the existing WhatsApp part (including its `phones.length === 0` early return, which now only skips WhatsApp). The WhatsApp behaviour must be unchanged.

- [ ] **Step 3: Outcomes** — in `deliverResultsCheckRequest`, after the update to `completed` succeeds and the previous status was not `completed`, call:

```ts
await notifyUserOfOutcome(
  "results_check",
  "completed",
  { userId: req.user_id ?? null, phone: req.phone_number, reference: req.id },
  { requestId: req.id, examBoard: req.exam_board, indexNumber: req.index_number },
)
```
  (use whichever owner-id column `results_check_requests` actually has; if none, omit `userId`. The result itself is still delivered by the existing WhatsApp message — this adds the SMS/email confirmation.) In the admin `PATCH` handler: read which statuses `updatePayload` can set (view lines ≈40–80); when it moves a request to a declined/failed/cancelled state **from a different state**, call `notifyUserOfOutcome("results_check", "rejected", {...}, { ..., reason })` with the admin-supplied reason if the payload has one; when it moves to completed through PATCH, call `completed` instead (only if `deliverResultsCheckRequest` did not already — guard on previous status).

- [ ] **Step 4: Tests, typecheck, commit**

```bash
git add lib app/api
git commit -m "feat(admin-actions): results-check requests alert admins by email/push and notify users

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: SMS sender-ID requests wiring

**Files:**
- Modify: `app/api/sms/sender-ids/route.ts` (POST), `app/api/admin/sms-sender-ids/approve/route.ts`, `app/api/admin/sms-sender-ids/reject/route.ts`
- Modify: `lib/admin-actions/wiring.test.ts`

Facts (verified): the user creates a request via `app/api/sms/sender-ids/route.ts` POST → `requestSenderId(account.id, body.sender_id)` (inserts `sms_sender_ids` row with `local_status: "pending"`, `sms_account_id`). Admin approval/rejection are the `approve`/`reject` routes: they call `approveSenderIdRequest`/`rejectSenderIdRequest` (tenant accounts) or `approveSenderId`/`rejectSenderId` (platform) and return `{ success: true, ... }` on `result.ok`. Provider polling can only activate platform-owned IDs (`sms_account_id` null), never tenant IDs — so polling needs no user notification.

- [ ] **Step 1: Find the owner column** — `grep -rn "sms_accounts" migrations lib/sms --include=*.sql --include=*.ts | head`; identify the column that links an SMS account to its user (e.g. `user_id`). Write down the exact name; the helper below uses it.

- [ ] **Step 2: Failing guards**

```ts
describe("sender-id wiring", () => {
  it("request creation alerts admins; approve/reject notify the owner", () => {
    expect(read("app/api/sms/sender-ids/route.ts")).toContain('alertAdminsOfRequest("sender_id"')
    expect(read("app/api/admin/sms-sender-ids/approve/route.ts")).toContain('notifyUserOfOutcome("sender_id", "approved"')
    expect(read("app/api/admin/sms-sender-ids/reject/route.ts")).toContain('notifyUserOfOutcome("sender_id", "rejected"')
  })
})
```

- [ ] **Step 3: Helper `lib/admin-actions/sender-id-hook.ts`** — `async function notifySenderIdOutcome(row: { id: string; sender_id: string; sms_account_id: string | null }, outcome: "approved" | "rejected", reason?: string)`: if `sms_account_id` is null return; look up the account's owner user id (column from Step 1) with the service client; call `notifyUserOfOutcome("sender_id", outcome, { userId, reference: row.id }, { senderIdId: row.id, senderId: row.sender_id, reason })`. Unit-test with a fake db (owner found / not found / account null → no call).

- [ ] **Step 4: Wire** — POST route: after `requestSenderId` returns ok, `await alertAdminsOfRequest("sender_id", { senderIdId: <new row id>, senderId: body.sender_id })`. Approve/reject routes: after `result.ok`, call `notifySenderIdOutcome(<row from getById(id)>, "approved" | "rejected", <reason if the body has one>)`. Fire it only when the row was actually pending (the services already refuse non-pending; confirm by reading `approveSenderIdRequest`/`rejectSenderIdRequest` and only notify when `ok`).

- [ ] **Step 5: Tests, typecheck, commit**

```bash
git add app/api lib/admin-actions
git commit -m "feat(admin-actions): sender-ID requests alert admins and notify owners on approve/reject

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Complaints wiring

**Files:**
- Modify: `app/api/complaints/create/route.ts`, `lib/whatsapp-bot/complaints.ts` (creation path), `app/api/admin/complaints/update/route.ts`, `app/api/admin/whatsapp-inbox/resolve-complaint/route.ts`
- Modify: `lib/admin-actions/wiring.test.ts`

Facts (verified): web complaints are created in `app/api/complaints/create/route.ts` (uploads evidence, inserts into `complaints`, then sends the *user* an in-app + push confirmation); WhatsApp complaints go through `lib/whatsapp-bot/complaints.ts` which calls `notifyAdminsNewComplaint` (WhatsApp to admins). The admin update route (`app/api/admin/complaints/update/route.ts`) applies `sanitized` fields (`status`, `resolution_notes`) and returns the row with `user:user_id (id, email)`; nothing notifies the user. `resolve-complaint` (WhatsApp inbox) resolves a complaint raised via the bot (guest: phone number, maybe no account).

- [ ] **Step 1: Failing guards**

```ts
describe("complaint wiring", () => {
  it("both creation paths alert admins", () => {
    expect(read("app/api/complaints/create/route.ts")).toContain('alertAdminsOfRequest("complaint"')
    expect(read("lib/whatsapp-bot/complaints.ts")).toContain('alertAdminsOfRequest("complaint"')
  })
  it("both resolution paths notify the user", () => {
    expect(read("app/api/admin/complaints/update/route.ts")).toContain('notifyUserOfOutcome("complaint"')
    expect(read("app/api/admin/whatsapp-inbox/resolve-complaint/route.ts")).toContain('notifyUserOfOutcome("complaint"')
  })
})
```

- [ ] **Step 2: Creation hooks** — web: after the successful complaint insert (before the response), `await alertAdminsOfRequest("complaint", { complaintId: <row id>, orderId, priority, summary: description?.slice(0, 200) })`. WhatsApp: next to the existing `notifyAdminsNewComplaint(complaint)` call add the same alert with the `WaComplaint` fields (read the type in that file). Keep the existing WhatsApp alert.

- [ ] **Step 3: Resolution hooks** — `update/route.ts`: before updating, read the current `status` (one select); after the update succeeds, if the status **changed** and the new status is `resolved` → `notifyUserOfOutcome("complaint", "resolved", { userId: complaint.user_id, reference: complaintId }, { complaintId, resolutionNotes: sanitized.resolution_notes })`; if the new status is a declined/closed-without-action value that the admin UI offers (read `app/admin/complaints/page.tsx` for the actual status list) → `rejected`. Do not notify for other transitions (e.g. `in_progress`). `resolve-complaint/route.ts`: after it resolves the complaint, notify with `{ phone: <complaint phone>, userId: <if present> }`, same guard on previous status.

- [ ] **Step 4: Tests, typecheck, commit**

```bash
git add app/api lib
git commit -m "feat(admin-actions): complaints alert admins by email/push and notify users on resolution

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Verification, runbook, rollout notes

**Files:**
- Create: `docs/superpowers/runbooks/admin-action-notifications.md`

- [ ] **Step 1: Full verification**

Run: `npx vitest run lib/admin-actions` (all pass), `npm run test:run` (only the 9 baseline failures), `npx tsc --noEmit -p .` (no errors in touched files), `npx next lint --dir lib/admin-actions` (0 errors).

- [ ] **Step 2: Duplicate-send audit** — for every migrated route, grep that no inline send for the same outcome remains: `grep -rnE "withdrawal_(approved|rejected)|shop_(approved|rejected)|afaCompleted" app lib --include=*.ts | grep -v "lib/admin-actions" | grep -v "email-service.ts\|notification-service.ts\|sms-service.ts"`. Any leftover inline send for an outcome now covered by the notifier is a double-send bug: remove it. Record the result in the runbook.

- [ ] **Step 3: Write the runbook** `docs/superpowers/runbooks/admin-action-notifications.md` (≤ 1 page): the flow table (create hook → admin alert; outcome hooks → user message, channels), where templates live (`lib/admin-actions/flows/*`), how to add a flow (context interface in `contexts.ts`, flow module, registry entry, wiring test, route call after a real state change), how to read results (`[ADMIN-ACTION]` log lines: `sent|skipped|failed` per channel), common causes of silence (no admin users, no push subscriptions, SMS credits exhausted → `sendSMS` logs, user has no email/phone), and the cost note (every outcome now sends an SMS).

- [ ] **Step 4: Commit**

```bash
git add docs lib
git commit -m "docs(admin-actions): runbook and duplicate-send audit

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage)

- Admin alerts email+push for all six flows: Tasks 3 (withdrawal create), 4 (shop create), 5 (AFA create + auto-fulfil failure), 6 (results-check before the WhatsApp early return), 7 (sender-ID create), 8 (web + WhatsApp complaints).
- User outcome email+SMS (+existing push/in-app): Tasks 3 (approve/reject/complete from 5 routes), 4, 5, 6, 7, 8; templates in Task 2.
- Migration of existing inline sends with no channel regression: Tasks 3–4 (+ Task 9 duplicate audit).
- Reliability rules (isolation, never throws, awaited, only after real change): Task 1 tests; conditional updates in Tasks 3–8.
- Guests / missing contacts: Task 1 (`Target` overrides, skips), Tasks 5/6/8 pass explicit phones.
- Out of scope respected: sub-agent requests, custom domains, manual-fulfil orders untouched.
- Open items from the spec resolved: AFA creator = `submitAfaOrder` (+ admin alert only when manual); withdrawal "completed" = complete route + transfer-OTP route + status cron (approve/bulk-approve send "approved"); sender-ID polling needs no user notification (tenant IDs are activated only by admin); admin deep links listed per flow (sender-ID page path to be confirmed in Task 2).
