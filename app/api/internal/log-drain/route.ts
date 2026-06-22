import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { raiseSecurityAlert } from "@/lib/security-alerts"

/**
 * POST /api/internal/log-drain
 *
 * Sink for the Vercel Log Drain (Drains API, schema log/v1). Vercel POSTs
 * batches of runtime/request logs here and signs each with HMAC-SHA1 over the
 * raw body using the drain secret (x-vercel-signature). We verify the signature,
 * scan the batch for application/network-layer attack patterns (admin-route
 * probing, auth-failure bursts, path scanning, firewall blocks) and raise
 * de-duped security_alerts (delivered by the system in migrations 0083-0085).
 *
 * This closes the gap that DB triggers can't see: abuse that hits the app/edge
 * but leaves no data-change footprint. Failed GoTrue logins still aren't here
 * (they bypass Vercel) — those need a Supabase Log Drain.
 */
export const maxDuration = 60

// Per-batch, per-IP thresholds. Attacks arrive as bursts (batched together),
// so per-batch counting catches them; de-dup prevents repeat spam across batches.
const ADMIN_PROBE_THRESHOLD = 3   // 401/403 on /admin paths -> critical
const AUTH_DENY_THRESHOLD = 10    // 401/403 anywhere -> high
const PATH_SCAN_THRESHOLD = 25    // 404s -> high
const WAF_THRESHOLD = 5           // firewall/WAF actions -> high

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = crypto.createHmac("sha1", secret).update(Buffer.from(rawBody, "utf-8")).digest("hex")
  const a = Buffer.from(expected, "utf-8")
  const b = Buffer.from(header, "utf-8")
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function parseLogs(rawBody: string): any[] {
  const trimmed = rawBody.trim()
  if (!trimmed) return []
  // JSON array form
  if (trimmed.startsWith("[")) {
    try { const arr = JSON.parse(trimmed); return Array.isArray(arr) ? arr : [] } catch { /* fall through */ }
  }
  // NDJSON (also handles whitespace-separated JSON objects)
  const out: any[] = []
  for (const line of trimmed.split("\n")) {
    const l = line.trim()
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch { /* skip malformed line */ }
  }
  // Single JSON object
  if (out.length === 0 && trimmed.startsWith("{")) {
    try { out.push(JSON.parse(trimmed)) } catch { /* ignore */ }
  }
  return out
}

interface Counters { authDeny: number; adminProbe: number; notFound: number; waf: number; samplePath: string }

export async function POST(req: NextRequest) {
  const secret = process.env.VERCEL_DRAIN_SECRET
  if (!secret) {
    // Not configured yet — accept so creation/test doesn't error, but do nothing.
    return NextResponse.json({ ok: true, note: "drain secret not set" })
  }

  const rawBody = await req.text()
  if (!verifySignature(rawBody, req.headers.get("x-vercel-signature"), secret)) {
    return NextResponse.json({ code: "invalid_signature", error: "signature did not match" }, { status: 403 })
  }

  const logs = parseLogs(rawBody)
  if (logs.length === 0) return NextResponse.json({ ok: true, processed: 0 })

  // Aggregate anomalies per client IP within this batch.
  const byIp = new Map<string, Counters>()
  const bump = (ip: string, patch: Partial<Counters>) => {
    const c = byIp.get(ip) || { authDeny: 0, adminProbe: 0, notFound: 0, waf: 0, samplePath: "" }
    Object.assign(c, {
      authDeny: c.authDeny + (patch.authDeny || 0),
      adminProbe: c.adminProbe + (patch.adminProbe || 0),
      notFound: c.notFound + (patch.notFound || 0),
      waf: c.waf + (patch.waf || 0),
      samplePath: patch.samplePath || c.samplePath,
    })
    byIp.set(ip, c)
  }

  for (const e of logs) {
    const proxy = e?.proxy || {}
    const ip: string = proxy.clientIp || "unknown"
    if (ip === "unknown") {
      // still count firewall actions without a clientIp under "unknown"
    }
    const status: number = typeof proxy.statusCode === "number" ? proxy.statusCode
      : typeof e?.statusCode === "number" ? e.statusCode : 0
    const path: string = proxy.path || e?.path || ""
    const isAdminPath = /\/admin(\/|$|\?)|\/api\/admin/i.test(path)
    const wafAction: string = proxy.wafAction || ""

    if (status === 401 || status === 403) {
      bump(ip, { authDeny: 1, adminProbe: isAdminPath ? 1 : 0, samplePath: path })
    }
    if (status === 404) bump(ip, { notFound: 1, samplePath: path })
    if (e?.source === "firewall" || ["deny", "challenge", "rate_limit"].includes(wafAction)) {
      bump(ip, { waf: 1, samplePath: path })
    }
  }

  let raised = 0
  for (const [ip, c] of byIp) {
    if (c.adminProbe >= ADMIN_PROBE_THRESHOLD) {
      if (await raiseSecurityAlert({
        severity: "critical", category: "admin_probe",
        title: `Admin-route probing from ${ip} (${c.adminProbe} blocked requests, e.g. ${c.samplePath})`,
        detail: { ip, count: c.adminProbe, sample_path: c.samplePath }, ip,
        source: "log-drain", dedupeKey: `${ip}:admin_probe`, dedupeWindowMin: 15,
      })) raised++
    } else if (c.authDeny >= AUTH_DENY_THRESHOLD) {
      if (await raiseSecurityAlert({
        severity: "high", category: "auth_deny_burst",
        title: `Auth-failure burst from ${ip} (${c.authDeny}x 401/403)`,
        detail: { ip, count: c.authDeny, sample_path: c.samplePath }, ip,
        source: "log-drain", dedupeKey: `${ip}:auth_deny_burst`, dedupeWindowMin: 15,
      })) raised++
    }
    if (c.notFound >= PATH_SCAN_THRESHOLD) {
      if (await raiseSecurityAlert({
        severity: "high", category: "path_scan",
        title: `Path scanning from ${ip} (${c.notFound}x 404)`,
        detail: { ip, count: c.notFound, sample_path: c.samplePath }, ip,
        source: "log-drain", dedupeKey: `${ip}:path_scan`, dedupeWindowMin: 15,
      })) raised++
    }
    if (c.waf >= WAF_THRESHOLD) {
      if (await raiseSecurityAlert({
        severity: "high", category: "firewall_block",
        title: `Firewall blocked ${c.waf} requests from ${ip}`,
        detail: { ip, count: c.waf, sample_path: c.samplePath }, ip,
        source: "log-drain", dedupeKey: `${ip}:firewall_block`, dedupeWindowMin: 15,
      })) raised++
    }
  }

  return NextResponse.json({ ok: true, processed: logs.length, alerts: raised })
}
