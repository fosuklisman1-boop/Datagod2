// Admin console: developer pause (write half). The SQL function audits in the same transaction.
import { getControls } from "@/lib/api-v2/controls"
import { bad, callWrite, charLen, NO_ADMIN, REFUSED_SINGLE_LINE, UUID_RE, type RpcClient, type WriteResult } from "./write-common"

export type { WriteResult }
interface Deps {
  invalidate: () => void
}
const DEFAULT_DEPS: Deps = { invalidate: () => getControls().invalidate() }

export async function setDeveloperPause(
  client: RpcClient,
  p: { userId: string; paused: boolean; reason: string; actorId: string | undefined },
  deps: Deps = DEFAULT_DEPS
): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (typeof p.userId !== "string" || !UUID_RE.test(p.userId)) return bad("Not a valid developer id.")
  if (typeof p.paused !== "boolean") return bad("paused must be true or false.")
  const reason = typeof p.reason === "string" ? p.reason.trim() : ""
  if (p.paused && (charLen(reason) < 3 || charLen(reason) > 200 || REFUSED_SINGLE_LINE.test(reason))) {
    return bad("Give a reason of 3 to 200 characters, plain text.", "bad_reason")
  }
  const out = await callWrite(client, "api_v2_set_developer_pause", {
    p_user: p.userId,
    p_paused: p.paused,
    p_reason: p.paused ? reason : null,
    p_actor: p.actorId,
  })
  if (!out.ok) return out.result
  if (out.data.changed === true) {
    try {
      deps.invalidate()
    } catch {
      // the 10 s TTL still applies
    }
  }
  return { status: 200, body: { ...out.data, ok: true } }
}
