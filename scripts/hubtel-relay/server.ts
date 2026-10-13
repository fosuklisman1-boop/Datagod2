// Run on the DigitalOcean droplet:  npx tsx scripts/hubtel-relay/server.ts
// On the droplet keep the repo-relative layout: copy only this file and
// lib/ussd-hubtel/relay-handler.ts, preserving both paths, so the import below resolves.
import http from "http"
import { createRelayHandler } from "../../lib/ussd-hubtel/relay-handler"

const required = ["RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_STATUS_BASIC_AUTH"] as const
for (const k of required) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1) }

// Never die silently. A rejection is logged and the process keeps serving; an uncaught exception
// leaves state unknown, so log it and exit non-zero for systemd (Restart=always) to restart us.
process.on("unhandledRejection", reason => { console.error("[relay] unhandledRejection:", reason) })
process.on("uncaughtException", err => { console.error("[relay] uncaughtException, exiting for restart:", err); process.exit(1) })

const MAX_BODY_BYTES = 64 * 1024

const handle = createRelayHandler({
  secret: process.env.RELAY_SECRET!,
  collectionAccount: process.env.HUBTEL_COLLECTION_ACCOUNT!,
  statusBasicAuth: process.env.HUBTEL_STATUS_BASIC_AUTH!,
  disbursementAccount: process.env.HUBTEL_DISBURSEMENT_ACCOUNT || undefined,
  balanceBasicAuth: process.env.HUBTEL_BALANCE_BASIC_AUTH || undefined,
})

function reply(res: http.ServerResponse, status: number, body: unknown, after?: () => void) {
  if (res.headersSent || res.writableEnded) { after?.(); return }
  res.writeHead(status, { "Content-Type": "application/json", ...(after ? { Connection: "close" } : {}) })
  res.end(JSON.stringify(body), after)
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  let size = 0
  let done = false // a reply has been decided (error/413); ignore the rest of the request

  res.on("error", e => console.error("[relay] response error:", e.message))
  req.on("error", e => {
    console.error("[relay] request error:", e.message)
    if (!done) { done = true; reply(res, 400, { error: "bad request" }) }
  })
  req.on("data", (c: Buffer) => {
    if (done) return
    size += c.length
    if (size > MAX_BODY_BYTES) {
      done = true
      reply(res, 413, { error: "payload too large" }, () => req.destroy())
      return
    }
    chunks.push(c)
  })
  req.on("end", async () => {
    if (done) return
    done = true
    try {
      let url: URL
      try { url = new URL(req.url ?? "/", "http://relay") } catch {
        reply(res, 400, { error: "bad url" }) // e.g. "GET //" throws in the URL parser
        return
      }
      const out = await handle({
        method: req.method ?? "GET", path: url.pathname, query: url.searchParams,
        authorization: (req.headers.authorization as string | undefined) ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      })
      reply(res, out.status, out.body)
    } catch (e) {
      console.error("[relay] handler error:", e)
      reply(res, 500, { error: "internal error" })
    }
  })
})
server.on("clientError", (err, socket) => {
  console.error("[relay] client error:", err.message)
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  else socket.destroy()
})
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1", () =>
  console.log(`hubtel relay listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8080}`))
