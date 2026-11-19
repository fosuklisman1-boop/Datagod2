import { NextRequest, NextResponse } from "next/server"
import { loadRoles, ROW_CAP } from "@/lib/roles/repo"
import { HUB_SERVICE_KEYS, validateRateChanges, validateReason } from "@/lib/roles/admin/validate"
import { airtimeFeeRateFor } from "@/lib/airtime-pricing"
import { resolveBuyerShares } from "@/lib/cashback/buyer-share"
import { effectiveShares, getCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"
import { requireHubAdmin, badRequest, mapRpcError, readJson, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

const ALLOWED_KEYS: ReadonlySet<string> = new Set(HUB_SERVICE_KEYS.map((k) => k.key))

// A representative service key per cashback group: resolveBuyerShares resolves by group for these (no per-service row).
const GROUP_PROBE: Record<string, string> = { airtime: "airtime_group", bundles: "data_group", bills: "bill_group" }

/** What a member of `slug` actually gets today for one hub service key. Reuses the live resolvers; no rule is re-implemented. */
async function effectiveRate(
  db: Parameters<typeof resolveBuyerShares>[0],
  slug: string,
  key: string,
  cfg: CashbackConfig,
): Promise<number> {
  const [kind, rest] = key.split(":")
  if (kind === "airtime_fee") return airtimeFeeRateFor(rest, slug)
  const probe = GROUP_PROBE[rest]
  if (kind !== "cashback_share" || !probe) throw new Error("unmapped service key")
  const share = (await resolveBuyerShares(db, slug, [probe], cfg)).get(probe)
  if (share !== undefined) return share
  // System tiers resolve to today's configured group share (the pure tier path).
  const legacy = effectiveShares(cfg, probe)
  return slug === "dealer" ? legacy.dealer : legacy.customer
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })

    const { data, error } = await db.from("role_service_rates").select("service_key, value").eq("role_id", id).limit(ROW_CAP)
    if (error || !Array.isArray(data) || data.length >= ROW_CAP) return serverError()
    const own = new Map<string, number>()
    for (const row of data as Array<{ service_key: unknown; value: unknown }>) {
      const v = Number(row.value)
      if (typeof row.service_key === "string" && row.value != null && Number.isFinite(v)) own.set(row.service_key, v)
    }

    const cfg = await getCashbackConfig(db)
    const rates = await Promise.all(
      HUB_SERVICE_KEYS.map(async ({ key, label }) => ({
        service_key: key,
        label,
        value: own.get(key) ?? null,
        effective: await effectiveRate(db, target.slug, key, cfg),
      })),
    )
    return NextResponse.json({ editable: !target.is_system, rates })
  } catch {
    console.error("[ROLES-HUB] rates read failed")
    return serverError()
  }
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })
    if (target.is_system) return NextResponse.json({ error: "System role rates cannot be edited" }, { status: 403 })

    const body = (await readJson(request)) as { changes?: unknown; reason?: unknown } | undefined
    const input = body && typeof body === "object" ? body : {}
    const reason = validateReason(input.reason)
    if (!reason.ok) return badRequest(reason.error)
    const changes = validateRateChanges(input.changes, ALLOWED_KEYS)
    if (!changes.ok) return badRequest(changes.error)

    const { error } = await db.rpc("admin_role_set_rates", {
      p_actor: adminId,
      p_reason: reason.value,
      p_role_id: id,
      p_changes: changes.value,
    })
    if (error) return mapRpcError(error)
    return NextResponse.json({ changed: changes.value.length })
  } catch {
    console.error("[ROLES-HUB] rates write failed")
    return serverError()
  }
}
