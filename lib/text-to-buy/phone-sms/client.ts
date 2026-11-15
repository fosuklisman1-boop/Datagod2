import net from "node:net"
import { buildSendBody, decodeResponse, parseKey } from "./sm4"

/**
 * Sends one SMS through the forwarder phone's HTTP server (SM4 envelope). Server-only. Never throws and never logs
 * (the url, key, number and text are all sensitive).
 *
 *  - sent: HTTP 200, decodes, code 200.
 *  - refused: the phone answered and said no (code not 200, HTTP not 200 or a redirect, an oversized or undecryptable body).
 *  - unreachable: nothing was accepted: the TCP probe failed, or fetch failed with a connect-phase or reset/closed-before-response
 *    error (ECONNRESET, EPIPE, UND_ERR_SOCKET, "other side closed", "terminated").
 *  - ambiguous: the request may have reached the phone (total timeout with no answer, a failed body read, any other failure):
 *    it may have sent. The router still falls back to Hubtel (a rare duplicate beats a silent loss).
 * Every non-sent result carries a `detail` from a fixed vocabulary (never an error message, url, number or text), so the
 * router can log WHY the SIM path failed. "probe_timeout" is reserved: the boolean probe cannot tell a timeout from an error.
 */

export type PhoneSendDetail =
  | "probe_failed" | "probe_timeout" | "connect_error" | "reset" | "timeout" | "http_status" | "redirect" | "bad_body" | "code_not_200" | "other"

export type PhoneSendResult =
  | { kind: "sent" }
  | { kind: "refused" | "unreachable" | "ambiguous"; detail?: PhoneSendDetail }

export type PhoneClientDeps = {
  fetch?: typeof fetch
  now?: () => number
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  connectTimeoutMs?: number
  totalTimeoutMs?: number
}

const MAX_BODY_BYTES = 4096
// Errors that prove nothing reached the phone: connect-phase failures, and a connection reset or closed before any response.
const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED"])
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])

function closedBeforeResponse(e: unknown): boolean {
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === "string" && (m.includes("other side closed") || m.includes("terminated"))
}

/** TCP connect probe: true once the socket connects (then destroyed at once); false on error or timeout. Never throws. */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let socket: net.Socket | null = null
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        socket?.destroy()
      } catch {
        // ignore
      }
      resolve(ok)
    }
    try {
      socket = net.connect({ host, port })
      socket.setTimeout(timeoutMs, () => finish(false))
      socket.once("connect", () => finish(true))
      socket.once("error", () => finish(false))
    } catch {
      finish(false)
    }
  })
}

function errorCode(e: unknown): string | undefined {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | null
  if (typeof any?.code === "string") return any.code
  if (typeof any?.cause?.code === "string") return any.cause.code
  return undefined
}

/** Reads at most MAX_BODY_BYTES; null when the body is larger. Throws on a read failure. */
async function readBounded(res: Response): Promise<string | null> {
  const declared = Number(res.headers?.get?.("content-length"))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!res.body) {
    const t = await res.text()
    return t.length > MAX_BODY_BYTES ? null : t
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function sendViaPhone(
  cfg: { url: string; keyHex: string },
  p: { simSlot: 1 | 2; to: string; text: string },
  deps: PhoneClientDeps = {},
): Promise<PhoneSendResult> {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const connect = deps.connect ?? tcpProbe
  const connectMs = deps.connectTimeoutMs ?? 3000
  const totalMs = deps.totalTimeoutMs ?? 6000
  const startedAt = Date.now()

  const key = parseKey(cfg.keyHex)
  if (!key) return { kind: "unreachable", detail: "other" }

  let body: string
  let target: string
  let host: string
  let port: number
  try {
    const u = new URL(cfg.url)
    host = u.hostname
    port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
    body = buildSendBody(key, cfg.keyHex, { ...p, nowMs: now() })
    target = `${cfg.url.replace(/\/+$/, "")}/sms/send`
  } catch {
    return { kind: "unreachable", detail: "other" }
  }

  // ONE total budget covers the probe and the fetch: the probe's limit is min(connectTimeoutMs, budget) and its elapsed time
  // comes off what the fetch may use.
  let reachable = false
  try {
    reachable = await connect(host, port, Math.min(connectMs, totalMs))
  } catch {
    reachable = false
  }
  if (!reachable) return { kind: "unreachable", detail: "probe_failed" }
  const remaining = totalMs - (Date.now() - startedAt)
  if (remaining <= 0) return { kind: "unreachable", detail: "probe_failed" }

  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, remaining)
  // Raced directly so a fetch that ignores its signal cannot hang the caller.
  const timeout = new Promise<"timeout">((resolve) => ac.signal.addEventListener("abort", () => resolve("timeout")))

  const run = async (): Promise<PhoneSendResult> => {
    let res: Response
    try {
      res = await doFetch(target, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ac.signal, redirect: "manual" })
    } catch (e) {
      if (timedOut) return { kind: "ambiguous", detail: "timeout" }
      const code = errorCode(e) ?? ""
      if (CONNECT_CODES.has(code)) return { kind: "unreachable", detail: "connect_error" }
      if (RESET_CODES.has(code) || closedBeforeResponse(e) || closedBeforeResponse((e as { cause?: unknown })?.cause)) {
        return { kind: "unreachable", detail: "reset" }
      }
      return { kind: "ambiguous", detail: "other" }
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return { kind: "refused", detail: "redirect" }
    if (res.status !== 200) return { kind: "refused", detail: "http_status" }
    let text: string | null
    try {
      text = await readBounded(res)
    } catch {
      return { kind: "ambiguous", detail: timedOut ? "timeout" : "other" }
    }
    if (text === null) return { kind: "refused", detail: "bad_body" }
    const out = decodeResponse(key, text)
    if (!out) return { kind: "refused", detail: "bad_body" }
    return out.code === 200 ? { kind: "sent" } : { kind: "refused", detail: "code_not_200" }
  }

  try {
    const winner = await Promise.race([run(), timeout])
    return winner === "timeout" ? { kind: "ambiguous", detail: "timeout" } : winner
  } catch {
    return { kind: "ambiguous", detail: "other" }
  } finally {
    clearTimeout(timer)
  }
}
