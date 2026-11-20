import { NextRequest, NextResponse } from "next/server"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { dispatchBundleOrder, type DataOrderRow } from "@/lib/standard-bundles/service"
import { executeSpecialResend, type ResendSource, type SpecialResendDeps } from "@/lib/standard-bundles/special-resend"
import { DATA_ORDERS_TABLE } from "@/lib/standard-bundles/admin"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resend a completed Special Bundles unit the customer did not receive: ONE replacement order (SBR- reference, not
 * charged, not refundable) bought again from the Hubtel float. All rules: lib/standard-bundles/special-resend.ts.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to resend" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  try {
    const { deps, db } = getBundlesRuntime()
    const d: SpecialResendDeps = {
      async getOrder(id) { return (await deps.getOrder(id)) as unknown as ResendSource | null },
      async findByReference(ref) {
        const { data, error } = await db.from(DATA_ORDERS_TABLE).select("id, status").eq("reference_code", ref).maybeSingle()
        if (error) throw error
        return (data as { id: string; status: string } | null) ?? null
      },
      async insertReplacement(row) {
        const { data, error } = await db.from(DATA_ORDERS_TABLE).insert(row).select("*").single()
        if (error) {
          if ((error as { code?: string }).code === "23505") return { ok: false, duplicate: true }
          throw error
        }
        auditLog(db, { adminId, action: "standard_bundles_special_resend_created", newValue: { orderId: body.orderId, replacementId: (data as any)?.id, reference: row.reference_code } })
        return { ok: true, order: data as DataOrderRow }
      },
      dispatch: order => dispatchBundleOrder(deps, order),
      now: Date.now,
    }
    const out = await executeSpecialResend(d, body.orderId, adminId)
    auditLog(db, {
      adminId, action: "standard_bundles_special_resend",
      newValue: { orderId: body.orderId, ok: out.ok, status: out.orderStatus ?? null, replacementId: out.replacementId ?? null, message: out.message },
    })
    return NextResponse.json({ ok: out.ok, status: out.orderStatus ?? null, replacementId: out.replacementId ?? null, message: out.message }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
