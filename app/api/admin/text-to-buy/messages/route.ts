import { NextRequest } from "next/server"
import { normaliseSender } from "@/lib/text-to-buy/admin-validate"
import { decodeCursor, isLine, isOutcome } from "@/lib/text-to-buy/admin-view"
import { listInbound, listThread } from "@/lib/text-to-buy/store"
import { fail, gate, isResponse, json, logError } from "@/lib/text-to-buy/admin-http"

// Customer texts and numbers: only a real admin user (not the cron bearer) may read them, nothing is cached, nothing is logged.
export const dynamic = "force-dynamic"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export async function GET(request: NextRequest) {
  const ctx = await gate(request, true)
  if (isResponse(ctx)) return ctx
  const { db } = ctx
  const p = new URL(request.url).searchParams

  const lineParam = p.get("line")
  if (lineParam && !isLine(lineParam)) return fail("invalid_line", 400)
  const line = lineParam && isLine(lineParam) ? lineParam : undefined

  try {
    const thread = p.get("thread")
    if (thread) {
      const sender = normaliseSender(thread)
      if (!sender) return fail("invalid_sender", 400)
      return json({ messages: await listThread(db, sender, line) })
    }

    const senderParam = p.get("sender")
    const sender = senderParam ? normaliseSender(senderParam) : null
    if (senderParam && !sender) return fail("invalid_sender", 400)

    const outcomeParam = p.get("outcome")
    if (outcomeParam && !isOutcome(outcomeParam)) return fail("invalid_outcome", 400)

    const cursorParam = p.get("cursor")
    const cursor = cursorParam ? decodeCursor(cursorParam) : null
    if (cursorParam && !cursor) return fail("invalid_cursor", 400)

    const limitParam = p.get("limit")
    let limit = DEFAULT_LIMIT
    if (limitParam !== null && limitParam !== "") {
      limit = /^\d{1,3}$/.test(limitParam) ? Number(limitParam) : 0
      if (limit < 1 || limit > MAX_LIMIT) return fail("invalid_limit", 400)
    }

    const page = await listInbound(db, {
      limit,
      line,
      sender: sender ?? undefined,
      outcome: outcomeParam && isOutcome(outcomeParam) ? outcomeParam : undefined,
      cursor: cursor ?? undefined,
    })
    return json(page)
  } catch (err) {
    logError("messages", err)
    return fail("server_error", 500)
  }
}
