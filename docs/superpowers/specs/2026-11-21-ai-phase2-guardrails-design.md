# AI Guardrails (Phase 2 of the AI assistant upgrade) — Design

Date: 2026-11-21 · Status: approved under the owner's standing pre-approval
("build all the phases, I pre-approve everything", 2026-11-21 00:51)

## 1. Intent

Phase 1 removed every tool that let the web AI move money or change accounts.
Today that guarantee rests on hand-maintained per-context arrays in
`aiTools()` plus one runtime check for admin-only tools. A future edit could
quietly re-add an executing tool, hand an admin tool to a dealer, or let a
suspended user keep chatting until their token expires.

Phase 2 makes those rules structural and test-enforced, so breaking them fails
the build instead of reaching production.

## 2. Goals

1. **One typed tool registry.** Every tool is declared once with
   `{ tool, contexts, adminOnly, acts, background }`. `aiTools(context)` and
   the runtime "is this tool allowed here?" check both derive from it.
2. **Invariant tests** that fail CI when a rule breaks:
   - tool names are unique;
   - every tool has at least one context;
   - an `adminOnly` tool is only in the `admin` context;
   - none of the Phase-1 forbidden names (`place_wallet_order`,
     `adjust_wallet_balance`, `manage_withdrawal`, `suspend_user`,
     `update_user_role`, `bulk_update_order_status`) exists;
   - no tool in `dashboard`, `storefront` or `home` has `acts: 'money'`;
   - the model-visible list for a context equals the callable set for it.
3. **Context-scoped execution.** `executeToolCall` refuses any tool not
   registered for the request's context, not only admin-only ones.
4. **Suspended accounts are refused on every request.** The chat route and the
   draft confirm/recheck routes re-read `users.is_suspended` each request; a
   suspended caller gets a fixed refusal and no model call (a token issued
   before the ban stays valid up to ~1 h).
5. **Tool-result fence can't be broken.** Any `<data>` / `</data>` text inside
   a tool result is neutralised before wrapping, so database text can't close
   the fence early.
6. **Chat history is normalised** before reaching any provider: drop a leading
   assistant turn, merge consecutive same-role turns, never send an empty turn.

## 3. Non-goals

- A restricted "reactivation" lane for suspended users (a suspension bans the
  login, so the web chat has no suspended audience beyond the token window).
- Moving the R21 remaining admin write tools behind cards (owner decision).
- Prompt caching / knowledge-base work (Phase 3).
- WhatsApp bot tool lists change shape only through the registry; their
  behaviour must not change.

## 4. Anti-goals

- Any change in which tools a context offers today. The registry must
  reproduce today's per-context lists exactly; a snapshot test proves it.
- Logging PII.

## 5. Design

### 5.1 Registry

`lib/ai-tool-registry.ts`:

```ts
type ToolCtx = 'home'|'storefront'|'dashboard'|'admin'|'whatsapp'|'whatsapp_shop'
type ActsKind = 'none'|'draft'|'money'|'account'|'ops'   // what calling it does
interface ToolEntry {
  tool: Anthropic.Tool          // the existing definition object
  contexts: ToolCtx[]
  adminOnly?: boolean
  acts: ActsKind                // 'draft' = writes ai_drafts only
  background?: 'allow'|'deny'   // cron background runs
}
export const TOOL_REGISTRY: readonly ToolEntry[]
export function toolsFor(context, flags?): Anthropic.Tool[]   // preserves today's order
export function isToolAllowed(name, context): boolean
```

`aiTools(context, storefrontServices)` becomes a thin wrapper over `toolsFor`
(storefront service flags still filter). The existing `ADMIN_ONLY_TOOLS` set
is derived from the registry. Background filters (`withoutPrepareTools`,
`adminBackgroundTools`) derive from `acts` / `background`, keeping today's
exact results.

Snapshot test: for every context (and storefront flag combinations), the tool
NAMES returned equal today's lists verbatim (captured before the refactor).

`acts` classification guide: read-only lookups `none`; `prepare_*` `draft`;
WhatsApp `place_whatsapp_order` / `place_shop_order` stage a confirm menu the
customer must answer — `draft`; R21 admin write tools `ops` (or `account` /
`money` where they genuinely move money or change accounts — classify
honestly; the invariant only forbids `money` in customer web contexts).

### 5.2 Context-scoped execution

`executeToolCall(name, input, ctx)` checks `isToolAllowed(name, ctx.context)`
first; refuse with `{ error: "tool_not_available" }` (and a PII-free log
marker). The runtime ctx gains a required `context` field; all callers (chat
route, cron, WhatsApp webhook, shop AI) pass it.

### 5.3 Suspension per request

`lib/auth/suspension.ts` `isSuspended(db, userId): Promise<boolean>` reads
`users.is_suspended` (read error → treat as suspended: fail closed).
Chat route: after resolving userId, if suspended → stream one fixed message
("Your account is suspended. Please contact support.") and stop; no model
call, no tools. Draft routes (confirm, recheck): suspended → 403
`{ error: "Account suspended" }`. GET/cancel stay allowed.

### 5.4 Fence hardening

In `lib/ai-agentic-loop.ts`, before wrapping: replace `<data…>` / `</data>`
(case-insensitive, optional spaces/attributes) in the serialised result with
`[data]` / `[/data]`. Test with a product name containing `</data>`.

### 5.5 History normalisation

`lib/ai-history.ts` `normaliseHistory(msgs)`: drop leading assistant messages;
merge consecutive same-role messages (join text with `\n\n`); drop empty ones;
drop trailing assistant messages so the last is a user turn. Used by the chat
route right after the client-note strip and before the card-results prepend.

## 6. Testing

TDD per task. Invariant tests in `lib/ai-tool-registry.test.ts`. Snapshot of
today's per-context tool names captured FIRST (before refactor) and asserted
after. Suspension tests on chat + draft routes. Fence and history unit tests.
Full suite: no new failures vs baseline (12 pre-existing failures in 4 files:
order-health-service, admin-users migration, pricing migration,
standard-bundles runtime).

## 7. Shipping

No migration. Standard push protocol: placeholder `next build`, check
origin/main, push, watch deploy, smoke-test (draft routes still 401 without
auth; home page 200).

## 8. Decisions log

All decisions are the controller's under the owner's pre-approval. Restricted
lane dropped (no audience given login bans).
