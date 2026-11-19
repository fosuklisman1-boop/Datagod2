import { NextRequest, NextResponse } from "next/server"
import { loadRolePrices, loadRoles, rolePricesFor, ROLE_ID_CHUNK, ROW_CAP } from "@/lib/roles/repo"
import { validatePriceChanges, validateReason } from "@/lib/roles/admin/validate"
import { requireHubAdmin, badRequest, mapRpcError, readJson, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

/** package_id -> cost for the given ids (chunked, <= ROLE_ID_CHUNK per read). Returns null on any read error (fail closed). */
async function loadCosts(db: { from: (t: string) => any }, ids: string[]): Promise<Map<string, number> | null> {
  const out = new Map<string, number>()
  for (let i = 0; i < ids.length; i += ROLE_ID_CHUNK) {
    const { data, error } = await db.from("package_costs").select("package_id, cost_price").in("package_id", ids.slice(i, i + ROLE_ID_CHUNK))
    if (error || !Array.isArray(data)) return null
    for (const row of data as Array<{ package_id: unknown; cost_price: unknown }>) {
      const c = Number(row.cost_price)
      if (row.cost_price != null && Number.isFinite(c)) out.set(String(row.package_id), c)
    }
  }
  return out
}

// admin and sub_agent have no price tier (the 0187 function refuses them too).
const NO_PRICE_TIER = new Set(["admin", "sub_agent"])

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

    const { data, error } = await db
      .from("packages")
      .select("id, network, name, price, dealer_price, is_available")
      .order("network")
      .order("name")
      .limit(ROW_CAP)
    // A full page cannot be proven complete: fail closed rather than show a truncated catalogue.
    if (error || !Array.isArray(data) || data.length >= ROW_CAP) return serverError()
    const pkgs = data as Array<{
      id: string; network: string; name: string; price: number | string; dealer_price: number | string | null
      is_available: boolean | null
    }>

    // Admin-only costs come from package_costs (service client); any read error fails the whole response.
    const costMap = await loadCosts(db, pkgs.map((p) => String(p.id)))
    if (!costMap) return serverError()

    const own = await loadRolePrices(db, [id], pkgs.map((p) => String(p.id)))
    const effective = await rolePricesFor(db, target.slug, pkgs)
    const ownMap = own.get(id)

    return NextResponse.json({
      editable: !NO_PRICE_TIER.has(target.slug),
      packages: pkgs.map((p) => ({
        id: String(p.id),
        network: p.network,
        name: p.name,
        price: Number(p.price),
        cost_price: costMap.get(String(p.id)) ?? null,
        role_price: ownMap?.get(String(p.id)) ?? null,
        effective_price: effective.get(String(p.id)) ?? Number(p.price),
        is_available: p.is_available === true,
      })),
    })
  } catch {
    console.error("[ROLES-HUB] prices read failed")
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
    if (NO_PRICE_TIER.has(target.slug)) return NextResponse.json({ error: "This role has no price tier" }, { status: 403 })

    const body = (await readJson(request)) as { changes?: unknown; loss_override?: unknown; reason?: unknown } | undefined
    const input = body && typeof body === "object" ? body : {}
    const reason = validateReason(input.reason)
    if (!reason.ok) return badRequest(reason.error)

    // Costs for exactly the requested package ids (chunked). Unknown ids stay out of the map and the validator rejects them.
    const costs = new Map<string, number | null>()
    if (Array.isArray(input.changes) && input.changes.length <= 1000) {
      const ids = [
        ...new Set(
          input.changes
            .map((c) => (c && typeof c === "object" ? (c as { package_id?: unknown }).package_id : undefined))
            .filter((x): x is string => typeof x === "string" && UUID_RE.test(x)),
        ),
      ]
      // Existence comes from packages (unknown ids stay out of the map); costs come from package_costs.
      for (let i = 0; i < ids.length; i += ROLE_ID_CHUNK) {
        const { data, error } = await db.from("packages").select("id").in("id", ids.slice(i, i + ROLE_ID_CHUNK))
        if (error || !Array.isArray(data)) return serverError()
        for (const row of data as Array<{ id: unknown }>) costs.set(String(row.id), null)
      }
      const found = await loadCosts(db, [...costs.keys()])
      if (!found) return serverError()
      for (const [pid, c] of found) costs.set(pid, c)
    }

    const checked = validatePriceChanges(input.changes, costs)
    if (!checked.ok) return badRequest(checked.error)
    const { changes, belowCost } = checked.value
    const lossOverride = input.loss_override === true
    if (belowCost.length > 0 && !lossOverride) {
      return NextResponse.json({ error: "Some prices are below cost.", below_cost: belowCost }, { status: 409 })
    }

    const { error } = await db.rpc("admin_role_set_prices", {
      p_actor: adminId,
      p_reason: reason.value,
      p_role_id: id,
      p_changes: changes,
      p_loss_override: lossOverride,
    })
    if (error) return mapRpcError(error)
    return NextResponse.json({ changed: changes.length })
  } catch {
    console.error("[ROLES-HUB] prices write failed")
    return serverError()
  }
}
