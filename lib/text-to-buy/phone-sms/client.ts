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
 *    it may have sent, so the caller must NOT resend through another transport.
 */

export type PhoneSendResult = { kind: "sent" } | { kind: "refused" } | { kind: "unreachable" } | { kind: "ambiguous" }

export type PhoneClientDeps = {
  fetch?: typeof fetch
  now?: () => number
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  connectTimeoutMs?: number
  totalTimeoutMs?: number
}

const MAX_BODY_BYTES = 4096
// Errors that prove nothing reached the phone: connect-phase failures, and a connection reset or closed before any response.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])

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
  if (!key) return { kind: "unreachable" }

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
    return { kind: "unreachable" }
  }

  // ONE total budget covers the probe and the fetch: the probe's limit is min(connectTimeoutMs, budget) and its elapsed time
  // comes off what the fetch may use.
  let reachable = false
  try {
    reachable = await connect(host, port, Math.min(connectMs, totalMs))
  } catch {
    reachable = false
  }
  if (!reachable) return { kind: "unreachable" }
  const remaining = totalMs - (Date.now() - startedAt)
  if (remaining <= 0) return { kind: "unreachable" }

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
      if (!timedOut && (NOT_SENT_CODES.has(errorCode(e) ?? "") || closedBeforeResponse(e) || closedBeforeResponse((e as { cause?: unknown })?.cause))) {
        return { kind: "unreachable" }
      }
      return { kind: "ambiguous" }
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return { kind: "refused" }
    if (res.status !== 200) return { kind: "refused" }
    let text: string | null
    try {
      text = await readBounded(res)
    } catch {
      return { kind: "ambiguous" }
    }
    if (text === null) return { kind: "refused" }
    const out = decodeResponse(key, text)
    if (!out) return { kind: "refused" }
    return out.code === 200 ? { kind: "sent" } : { kind: "refused" }
  }

  try {
    const winner = await Promise.race([run(), timeout])
    return winner === "timeout" ? { kind: "ambiguous" } : winner
  } catch {
    return { kind: "ambiguous" }
  } finally {
    clearTimeout(timer)
  }
}
