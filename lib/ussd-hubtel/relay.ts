// lib/ussd-hubtel/relay.ts
// Vercel-side client for the DO relay. Never calls Hubtel directly.
function relayConfig(): { url: string; secret: string } | null {
  const url = process.env.HUBTEL_RELAY_URL
  const secret = process.env.HUBTEL_RELAY_SECRET
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null
}

export async function sendFulfillmentCallback(p: { sessionId: string; orderId: string }): Promise<{ ok: boolean; error?: string }> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.secret}` },
      // Always "success": spec §8 (failures are handled in our own admin / refunds, not via Hubtel).
      body: JSON.stringify({ SessionId: p.sessionId, OrderId: p.orderId, ServiceStatus: "success", MetaData: null }),
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) return { ok: false, error: `relay/hubtel ${json?.upstreamStatus ?? res.status}: ${JSON.stringify(json?.body ?? null).slice(0, 200)}` }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

export async function checkTransactionStatus(
  sessionId: string
): Promise<{ ok: boolean; status?: string; data?: any; error?: string }> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/status?clientReference=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) return { ok: false, error: `relay/hubtel ${json?.upstreamStatus ?? res.status}` }
    const data = json.body?.data
    return { ok: true, status: data?.status, data }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
