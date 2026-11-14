import { NextRequest } from "next/server"
import { loadTtbSettings } from "@/lib/text-to-buy/settings"
import { normaliseSender } from "@/lib/text-to-buy/admin-validate"
import { processInbound } from "@/lib/text-to-buy/handle-inbound"
import { fail, gate, isResponse, json, logError, readObject, tryAllowed } from "@/lib/text-to-buy/admin-http"

// "Try it": run a pretend text through the real reader and rules and show the reply that would go out. A dry run places no
// order, sends no SMS and writes nothing. It does NOT go through acceptInbound (no row is stored). Never log the text or number.
export const dynamic = "force-dynamic"

const MAX_TEXT = 500

export async function POST(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db, userId } = ctx

  const body = await readObject(request)
  if (!body) return fail("invalid_body", 400)
  if (body.line !== "main") return fail("invalid_line", 400)
  const sender = normaliseSender(body.sender)
  if (!sender) return fail("invalid_sender", 400)
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (text.length < 1 || text.length > MAX_TEXT) return fail("invalid_text", 400)

  const now = new Date()
  if (!tryAllowed(userId as string, now.getTime())) return fail("rate_limited", 429)

  try {
    const live = await loadTtbSettings(db)
    // A dry run places nothing and writes nothing, so the admin can preview airtime and vouchers before switching them on.
    const settings = { ...live, airtimeEnabled: true, resultsCheckerEnabled: true }
    const result = await processInbound(
      db,
      crypto.randomUUID(),
      { line: "main", from: sender, text, receivedAt: null, now },
      settings,
      { dryRun: true },
    )
    return json({ readBy: result.readBy, outcome: result.outcome, reply: result.reply })
  } catch (err) {
    logError("try", err)
    return fail("server_error", 500)
  }
}
