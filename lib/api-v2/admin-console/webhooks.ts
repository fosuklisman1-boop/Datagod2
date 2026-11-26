// Release 6 admin webhooks switch: read it with today's delivery counts, and turn it on or off. Writes take the actor
// only from verifyAdminAccess (the CRON path has none -> 403). The switch write is excluded from the admin AI (go-live
// decision that starts outbound HTTP to developer URLs).
import { bad, NO_ADMIN, type RpcClient, type WriteResult } from "./write-common"
import { callRead, readFailure } from "./read-common"

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : 0)

export async function getWebhookSettingsAdmin(client: RpcClient, now: Date): Promise<WriteResult> {
  const r = await callRead(client, "api_v2_webhook_settings_get", { p_now: now.toISOString() })
  if (!r.ok) return r.result
  const d = obj(r.data)
  const t = obj(d.today)
  return {
    status: 200,
    body: {
      enabled: d.enabled === true,
      updatedAt: typeof d.updated_at === "string" ? d.updated_at : null,
      endpoints: num(d.endpoints),
      today: { pending: num(t.pending), delivered: num(t.delivered), failed: num(t.failed) },
    },
  }
}

export async function saveWebhookSettings(client: RpcClient, p: { enabled: unknown; actorId: string | undefined }): Promise<WriteResult> {
  if (!p.actorId) return NO_ADMIN
  if (typeof p.enabled !== "boolean") return bad("enabled must be true or false.")
  try {
    const res = await client.rpc("api_v2_webhook_settings_set", { p_enabled: p.enabled, p_actor: p.actorId })
    if (res.error) return readFailure("api_v2_webhook_settings_set", res.error)
    return { status: 200, body: { ok: true, changed: obj(res.data).changed === true } }
  } catch {
    return readFailure("api_v2_webhook_settings_set", null)
  }
}
