import type { Metadata } from "next"
import { StatusBoard } from "@/components/developer/StatusBoard"

export const metadata: Metadata = {
  title: "API status | Datagod Developers",
  description: "Live status of each Datagod API v2 service: operational, degraded or paused, with the 24-hour success rate.",
}

// Static page: the board loads /api/developers/status in the browser, so the build never needs the database.
export default function StatusPage() {
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-wider text-primary">API v2</p>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">API status</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Whether each service is working right now. A paused service refuses new purchases and sends with HTTP 503 and the message shown
          here; order lookups keep working. Retry a purchase with the same reference once it is back: nothing is charged twice.
        </p>
      </header>
      <StatusBoard />
    </div>
  )
}
