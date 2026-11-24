// Admin console: per-service pause (write half).
import { getControls } from "@/lib/api-v2/controls"
import { SERVICES } from "@/lib/api-v2/services"
import { bad, callWrite, charLen, NO_ADMIN, REFUSED_SINGLE_LINE, type RpcClient, type WriteResult } from "./write-common"
import { readFailure } from "./read-common"

interface Deps {
  invalidate: () => void
}
const DEFAULT_DEPS: Deps = { invalidate: () => getControls().invalidate() }

export async function setServicePause(
  client: RpcClient,
  p: { service: string; paused: boolean; message: string | null; actorId: string | undefined },
  deps: Deps = DEFAULT_DEPS
): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (!SERVICES.some((s) => s.id === p.service)) return { status: 404, body: { error: "Unknown service.", code: "not_found" } }
  if (typeof p.paused !== "boolean") return bad("paused must be true or false.")
  if (p.message !== null && p.message !== undefined && typeof p.message !== "string") return bad("message must be text.", "bad_message")
  const message = typeof p.message === "string" ? p.message.trim() : ""
  if (p.paused && message && (charLen(message) > 200 || REFUSED_SINGLE_LINE.test(message))) {
    return bad("The message must be at most 200 characters of plain text.", "bad_message")
  }
  const out = await callWrite(client, "api_v2_set_service_pause", {
    p_service: p.service,
    p_paused: p.paused,
    p_message: p.paused && message ? message : null,
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

// ---------------- read half ----------------

export interface ServiceControlRow {
  id: string
  title: string
  paused: boolean
  message: string | null
  updatedAt: string | null
  updatedBy: string | null
  /** No controls row for this service: treated as not paused, and flagged so the admin sees the gap. */
  missing: boolean
}

/** Always the seven services, in the fixed order; unknown rows from the table are ignored. */
export async function listServices(client: RpcClient): Promise<WriteResult> {
  let res: { data: unknown; error: unknown }
  try {
    res = (await client.from("api_v2_service_controls").select("service, paused, message, updated_at, updated_by")) as typeof res
  } catch {
    return readFailure("api_v2_service_controls", null)
  }
  if (res.error) return readFailure("api_v2_service_controls", res.error)
  const byId = new Map<string, Record<string, unknown>>()
  for (const r of Array.isArray(res.data) ? res.data : []) {
    if (r && typeof r === "object" && typeof (r as { service?: unknown }).service === "string") byId.set((r as { service: string }).service, r as Record<string, unknown>)
  }
  const services: ServiceControlRow[] = SERVICES.map(({ id, title }) => {
    const r = byId.get(id)
    if (!r) return { id, title, paused: false, message: null, updatedAt: null, updatedBy: null, missing: true }
    return {
      id, title, paused: r.paused === true, message: typeof r.message === "string" ? r.message : null,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : null, updatedBy: typeof r.updated_by === "string" ? r.updated_by : null,
      missing: false,
    }
  })
  return { status: 200, body: { services } }
}
