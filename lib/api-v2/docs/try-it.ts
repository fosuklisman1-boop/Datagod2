// Try-it console logic. Pure functions, no storage. The key only ever appears in init.headers.
import type { V2Endpoint } from "./registry"

export const TRY_IT_BASE = "/api/v2"
export const TRY_IT_MAX_DISPLAY = 200_000
export const TRY_IT_TIMEOUT_MS = 20_000

export const TEST_KEY_PATTERN = /^dg2_(?:cs_|sms_)?test_[0-9a-f]+$/
const LIVE_KEY_PATTERN = /^(?:dg2_(?:cs_|sms_)?live_|dg_live_)/

export type KeyCheck = { ok: true; key: string } | { ok: false; reason: "empty" | "live" | "invalid" }

/** Trims, then allows only test-key shapes. The reason is a fixed literal and never echoes the input. */
export function checkTestKey(raw: string): KeyCheck {
  const key = (raw ?? "").trim()
  if (!key) return { ok: false, reason: "empty" }
  if (TEST_KEY_PATTERN.test(key)) return { ok: true, key }
  if (LIVE_KEY_PATTERN.test(key)) return { ok: false, reason: "live" }
  return { ok: false, reason: "invalid" }
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1])
}

export type TryItRequest = { ok: true; url: string; init: RequestInit } | { ok: false; error: string }

export function buildTryItRequest(
  ep: Pick<V2Endpoint, "method" | "path" | "requestExample">,
  input: { key: string; pathParams: Record<string, string>; body: string }
): TryItRequest {
  const check = checkTestKey(input.key)
  if (!check.ok) return { ok: false, error: "A test key is required." }

  let path = ep.path
  for (const name of pathParamNames(ep.path)) {
    const value = (input.pathParams[name] ?? "").trim()
    if (!value) return { ok: false, error: `Enter a value for the path parameter "${name}".` }
    path = path.split(`{${name}}`).join(encodeURIComponent(value))
  }

  let body: string | undefined
  if (ep.method === "POST" && ep.requestExample !== null && input.body.trim() !== "") {
    try {
      body = JSON.stringify(JSON.parse(input.body))
    } catch {
      return { ok: false, error: "The request body is not valid JSON." }
    }
  }

  return {
    ok: true,
    url: TRY_IT_BASE + path,
    init: {
      method: ep.method,
      headers: { Authorization: check.key, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body } : {}),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    },
  }
}

export interface TryItResult {
  status: number | null
  elapsedMs: number
  kind: "json" | "text" | "empty" | "network-error"
  display: string
  truncated: boolean
}

function cap(text: string): { display: string; truncated: boolean } {
  return text.length > TRY_IT_MAX_DISPLAY ? { display: text.slice(0, TRY_IT_MAX_DISPLAY), truncated: true } : { display: text, truncated: false }
}

export function summariseResponse(status: number, elapsedMs: number, text: string, contentType: string | null): TryItResult {
  if (text === "") return { status, elapsedMs, kind: "empty", display: "", truncated: false }
  if (contentType && /json/i.test(contentType)) {
    try {
      return { status, elapsedMs, kind: "json", ...cap(JSON.stringify(JSON.parse(text), null, 2)) }
    } catch {
      // fall through to plain text
    }
  }
  return { status, elapsedMs, kind: "text", ...cap(text) }
}

/** Never throws. A failure shows only the error name, not its message. */
export async function runTryIt(
  req: Extract<TryItRequest, { ok: true }>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => Date.now()
): Promise<TryItResult> {
  const start = now()
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), TRY_IT_TIMEOUT_MS) : null
  try {
    const res = await fetchImpl(req.url, controller ? { ...req.init, signal: controller.signal } : req.init)
    const text = await res.text()
    // Defence in depth: an echoing server must not be able to put the key on screen.
    const key = (req.init.headers as Record<string, string>).Authorization
    const safe = key ? text.split(key).join("[redacted]") : text
    return summariseResponse(res.status, now() - start, safe, res.headers?.get("content-type") ?? null)
  } catch (e) {
    const name = e instanceof Error && /^[A-Za-z]+$/.test(e.name) ? e.name : "Error"
    return { status: null, elapsedMs: now() - start, kind: "network-error", display: `Request failed (${name}).`, truncated: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
