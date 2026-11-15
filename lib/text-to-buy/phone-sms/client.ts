import { buildSendBody, decodeResponse, parseKey } from "./sm4"

/**
 * Sends one SMS through the forwarder phone's HTTP server (SM4 envelope). Server-only. Never throws and never logs
 * (the url, key, number and text are all sensitive).
 *
 *  - sent: HTTP 200, decodes, code 200.
 *  - refused: the phone answered and said no (code not 200, HTTP not 200, or an undecryptable body).
 *  - unreachable: nothing was ever accepted (DNS, connection refused, or the connect timeout fired before any response).
 *  - ambiguous: the request was on the wire but the total timeout fired first; the phone may have sent.
 */

export type PhoneSendResult = { kind: "sent" } | { kind: "refused" } | { kind: "unreachable" } | { kind: "ambiguous" }

export type PhoneClientDeps = { fetch?: typeof fetch; now?: () => number; connectTimeoutMs?: number; totalTimeoutMs?: number }

export async function sendViaPhone(
  cfg: { url: string; keyHex: string },
  p: { simSlot: 1 | 2; to: string; text: string },
  deps: PhoneClientDeps = {},
): Promise<PhoneSendResult> {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const connectMs = deps.connectTimeoutMs ?? 3000
  const totalMs = deps.totalTimeoutMs ?? 8000

  const key = parseKey(cfg.keyHex)
  if (!key) return { kind: "unreachable" }

  let body: string
  let target: string
  try {
    body = buildSendBody(key, cfg.keyHex, { ...p, nowMs: now() })
    target = `${cfg.url.replace(/\/+$/, "")}/sms/send`
  } catch {
    return { kind: "unreachable" }
  }

  const ac = new AbortController()
  let headersArrived = false
  let connectFired = false
  let totalFired = false
  const connectTimer = setTimeout(() => {
    if (headersArrived) return
    connectFired = true
    ac.abort()
  }, connectMs)
  const totalTimer = setTimeout(() => {
    totalFired = true
    ac.abort()
  }, totalMs)

  // Also race the timers directly so a fetch that ignores its signal cannot hang the caller.
  const timeouts = new Promise<"connect" | "total">((resolve) => {
    ac.signal.addEventListener("abort", () => resolve(connectFired ? "connect" : "total"))
  })

  const run = async (): Promise<PhoneSendResult> => {
    let res: Response
    try {
      res = await doFetch(target, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ac.signal })
    } catch {
      // No response at all: a connect-phase abort or any network error is a clean "nothing was accepted"; only the total
      // timer (connect not fired) means the request was in flight.
      return totalFired && !connectFired ? { kind: "ambiguous" } : { kind: "unreachable" }
    }
    headersArrived = true
    if (res.status !== 200) return { kind: "refused" }
    let text: string
    try {
      text = await res.text()
    } catch {
      return { kind: "ambiguous" }
    }
    const out = decodeResponse(key, text)
    if (!out) return { kind: "refused" }
    return out.code === 200 ? { kind: "sent" } : { kind: "refused" }
  }

  try {
    const winner = await Promise.race([run(), timeouts])
    if (winner === "connect") return { kind: "unreachable" }
    if (winner === "total") return { kind: "ambiguous" }
    return winner
  } catch {
    return { kind: "unreachable" }
  } finally {
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
  }
}
