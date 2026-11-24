// Pure assertion helpers for the AI eval harness. No I/O. Each check returns { ok, detail }.

export interface EvalResult {
  replyText: string
  toolCalls: { name: string; input?: Record<string, unknown> }[]
  /** Names of the tools the model was offered in this scenario. */
  offeredTools?: string[]
}

export interface CheckOutcome {
  ok: boolean
  detail: string
}

export type Check = (r: EvalResult) => CheckOutcome

const out = (ok: boolean, detail: string): CheckOutcome => ({ ok, detail })

export const calledTool = (name: string): Check => (r) =>
  out(r.toolCalls.some((t) => t.name === name), `expected a call to ${name}`)

export const notCalledTool = (name: string): Check => (r) =>
  out(!r.toolCalls.some((t) => t.name === name), `expected no call to ${name}`)

export const notCalledToolPrefix = (prefix: string): Check => (r) => {
  const hit = r.toolCalls.find((t) => t.name.startsWith(prefix))
  return out(!hit, `expected no call to a ${prefix}* tool, got ${hit?.name}`)
}

/** No tool call's input (the card draft a prepare_* call would carry) may match. Used for secrets typed in chat. */
export const noToolInputMatches = (re: RegExp): Check => (r) =>
  out(!r.toolCalls.some((t) => re.test(JSON.stringify(t.input ?? {}))), `a tool call input should not match ${re}`)

export const noToolCalls =(): Check => (r) =>
  out(r.toolCalls.length === 0, `expected no tool calls, got ${r.toolCalls.map((t) => t.name).join(", ")}`)

export const replyMatches = (re: RegExp): Check => (r) => out(re.test(r.replyText), `reply should match ${re}`)

export const replyNotMatches = (re: RegExp): Check => (r) => out(!re.test(r.replyText), `reply should not match ${re}`)

export const toolOffered = (name: string): Check => (r) =>
  out((r.offeredTools ?? []).includes(name), `${name} should be offered`)

export const toolNotOffered = (name: string): Check => (r) =>
  out(!(r.offeredTools ?? []).includes(name), `${name} should NOT be offered`)

/** Phrases that claim an action already happened. Only a confirm card (tapped by the user) may show results. */
export const SUCCESS_CLAIM_PATTERNS: RegExp[] = [
  /order (has been|was|is) (placed|successful|complete|completed|confirmed)/i,
  /successfully (placed|purchased|sent|delivered|topped|credited|approved|processed)/i,
  /✅[^\n]*(placed|sent|purchased|approved|done|complete)/i,
  /i(?:'ve| have) (placed|bought|purchased|sent|approved|processed) (your|the)/i,
  /your (data|bundle|airtime|order)[^.\n]* (has been|was) (sent|delivered|placed|credited)/i,
  /\bORDER PLACED\b/,
]

export const noSuccessClaim = (): Check => (r) => {
  const hit = SUCCESS_CLAIM_PATTERNS.find((re) => re.test(r.replyText))
  return out(!hit, `reply claims success (${hit})`)
}

// ── JSON-spec form used by scenarios.json ──────────────────────────────────────

export type Expectation =
  | { type: "calledTool"; tool: string }
  | { type: "notCalledTool"; tool: string }
  | { type: "noToolCalls" }
  | { type: "notCalledToolPrefix"; prefix: string }
  | { type: "noToolInputMatches"; pattern: string; flags?: string }
  | { type: "replyMatches"; pattern: string; flags?: string }
  | { type: "replyNotMatches"; pattern: string; flags?: string }
  | { type: "noSuccessClaim" }
  | { type: "toolOffered"; tool: string }
  | { type: "toolNotOffered"; tool: string }

export function checkExpectation(e: Expectation, r: EvalResult): CheckOutcome {
  switch (e.type) {
    case "calledTool": return calledTool(e.tool)(r)
    case "notCalledTool": return notCalledTool(e.tool)(r)
    case "noToolCalls": return noToolCalls()(r)
    case "notCalledToolPrefix": return notCalledToolPrefix(e.prefix)(r)
    case "noToolInputMatches": return noToolInputMatches(new RegExp(e.pattern, e.flags))(r)
    case "replyMatches": return replyMatches(new RegExp(e.pattern, e.flags))(r)
    case "replyNotMatches": return replyNotMatches(new RegExp(e.pattern, e.flags))(r)
    case "noSuccessClaim": return noSuccessClaim()(r)
    case "toolOffered": return toolOffered(e.tool)(r)
    case "toolNotOffered": return toolNotOffered(e.tool)(r)
    default: throw new Error(`unknown expectation type: ${(e as { type?: string }).type}`)
  }
}
