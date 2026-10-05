// scripts/hubtel-relay/server.ts
// Run on the DigitalOcean droplet:  npx tsx server.ts
// Copy this file and lib/ussd-hubtel/relay-handler.ts side by side and fix the import below.
import http from "http"
import { createRelayHandler } from "./relay-handler"

const required = ["RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_STATUS_BASIC_AUTH"] as const
for (const k of required) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1) }

const handle = createRelayHandler({
  secret: process.env.RELAY_SECRET!,
  collectionAccount: process.env.HUBTEL_COLLECTION_ACCOUNT!,
  statusBasicAuth: process.env.HUBTEL_STATUS_BASIC_AUTH!,
})

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", c => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024) req.destroy() })
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", "http://relay")
    const out = await handle({
      method: req.method ?? "GET", path: url.pathname, query: url.searchParams,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    })
    res.writeHead(out.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(out.body))
  })
})
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1", () =>
  console.log(`hubtel relay listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8080}`))
