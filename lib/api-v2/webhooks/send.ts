// Release 6 webhook request building and the real HTTPS transport. The transport connects to the address resolveSafe
// vetted (pinnedLookup), never follows redirects (node https does not), times out after timeoutMs, and reads at most
// 1 KB of the reply.
import https from "https"
import { signatureHeader } from "./sign"
import { pinnedLookup } from "./url-guard"

export interface Deliverable {
  id: string
  type: string
  payload: unknown
  secret: string
}

export function buildDelivery(d: Deliverable, tSeconds: number): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(d.payload)
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Datagod-Webhooks/1",
      "Datagod-Event-Id": d.id,
      "Datagod-Event-Type": d.type,
      "Datagod-Signature": signatureHeader(d.secret, body, tSeconds),
    },
  }
}

/** The first 200 printable characters of a reply, control characters removed. */
export function snippetOf(text: string | null | undefined): string | null {
  if (text == null) return null
  return String(text).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200)
}

export interface PostRequest {
  url: string
  headers: Record<string, string>
  body: string
  address: string
  family: number
  timeoutMs: number
}

export function httpsPost(p: PostRequest): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const req = https.request(
      p.url,
      {
        method: "POST",
        headers: { ...p.headers, "Content-Length": String(Buffer.byteLength(p.body)) },
        lookup: pinnedLookup(p.address, p.family) as never,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (c: Buffer) => {
          if (size < 1024) chunks.push(c.subarray(0, 1024 - size))
          size += c.length
          if (size >= 1024) res.destroy()
        })
        const end = () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
        res.on("end", end)
        res.on("close", end)
        res.on("error", end)
      },
    )
    const timer = setTimeout(() => {
      const e = new Error("webhook timed out")
      e.name = "TimeoutError"
      finish(() => reject(e))
      req.destroy()
    }, p.timeoutMs)
    req.on("error", (e) => finish(() => reject(e)))
    req.end(p.body)
  })
}
