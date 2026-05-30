import { checkBotId } from "botid/server"
import { NextResponse } from "next/server"

/**
 * Returns a 403 response if the request is from a bot, otherwise null.
 * Usage: const blocked = await rejectBot(); if (blocked) return blocked;
 */
export async function rejectBot(): Promise<NextResponse | null> {
  try {
    const result = await checkBotId()
    if (result.isBot) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 })
    }
    return null
  } catch {
    // Fail open — never block real users due to BotID service errors
    return null
  }
}
