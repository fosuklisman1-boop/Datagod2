# AI Prompt Caching + Knowledge Injection (Phase 3) — Design

Date: 2026-11-21 · Status: approved under the owner's standing pre-approval
("build all the phases, I pre-approve everything", 2026-11-21 00:51)

## 1. Intent

Every web chat request rebuilds a long system prompt with per-user details
(name, role, today's date, card nonce) woven into the top and middle, so
nothing can be cached. The knowledge base (`ai_knowledge`, ~20 entries) is
only reachable through a 5-row keyword search tool, so policy answers are
inconsistent.

Phase 3 splits every web prompt into a stable prefix (identical for every
user of the same context/shop/role class) and a small volatile tail, caches
the prefix on Anthropic, and injects the whole knowledge base into the stable
prefix when it fits a budget.

## 2. Goals

1. Prompt builder split: for each web context (home, storefront, dashboard,
   admin) the system prompt is `{ stable, volatile }`. The volatile tail holds
   ONLY per-request values: names, per-user role label, today's date, current
   page if any, the card-results nonce rule. Everything else is in `stable`.
2. Stable is byte-identical: a test builds two users / two dates in the same
   context (same shop for storefront) and asserts `stable` identical,
   `volatile` different.
3. Anthropic caching: system sent as two text blocks
   `[{stable, cache_control:{type:"ephemeral"}}, {volatile}]` (tools render
   first, so one breakpoint caches tools + stable). OpenAI/Gemini receive
   `stable + "\n\n" + volatile` (stable first for automatic prefix caching).
4. Deterministic tool list per context (assert identical across requests).
5. Knowledge injection: active `ai_knowledge` entries for the context label,
   sorted by category then question, rendered whole into a `## Knowledge base`
   section at the end of `stable`, up to `KNOWLEDGE_BUDGET_CHARS = 12000`;
   over budget → inject NONE (never partial). `get_knowledge_base` stays
   registered (no tool-list change). 60 s in-memory cache per label.
6. Observability: PII-free debug log of `cache_read_input_tokens` /
   `cache_creation_input_tokens` per Anthropic call.

## 3. Non-goals
WhatsApp / shop-bot / cron prompts; admin budget meter (Phase 5); knowledge
content changes; 1-hour TTL.

## 4. Anti-goals
- Any change to which tools a context offers (Phase-2 snapshot untouched).
- Dropping or rewording any existing prompt rule — `stable + volatile` must
  contain every rule it did before (only moves + the knowledge section).
- Any per-request value (timestamp, nonce, id, name, balance) in `stable`.
- Logging PII or prompt text.

## 5. Design

### 5.1 Builders
`lib/ai-prompts/` (new), one module per web context exporting
`build<Ctx>Prompt(input): { stable: string; volatile: string }`, inputs split
into stable (context, shop name/services/USSD code, role class where rules
differ, knowledge text) and volatile (names, today, nonce). The chat route
calls the builder. Golden test per context: capture today's rendered prompt
for fixed inputs BEFORE refactoring; assert every non-empty line of it
appears in `stable + "\n\n" + volatile`.

### 5.2 Provider
`AIProvider.createMessage` accepts `system: string | { stable; volatile }`.
Anthropic adapter: object → two blocks, `cache_control` on the first; string
→ unchanged. OpenAI/Gemini: object → joined string. `runAgenticLoop` passes it
through; cron / WhatsApp callers keep strings.

### 5.3 Knowledge
`lib/ai-prompts/knowledge.ts`: `loadKnowledge(db, label)` (60 s cache; labels
home/storefront → 'storefront', dashboard → 'dashboard', admin → 'admin',
matching the tool) and `renderKnowledge(entries, budget)` → string or `''`.
Read error → `''` + PII-free marker. Format per entry:
`### <category>\nQ: <question>\nA: <answer>`. One added prompt line: "Answer
policy questions from the Knowledge base section when it covers them;
otherwise use get_knowledge_base."

## 6. Testing
Golden capture first; stable-identical per context; provider block shape;
knowledge all-or-nothing, sorted, cache TTL, read error; Phase-2 snapshot
untouched; full suite baseline only (12 pre-existing failures in 4 files).

## 7. Shipping
No migration. Placeholder `next build`, origin/main check, push, watch deploy,
smoke (`/` 200, draft routes 401).
