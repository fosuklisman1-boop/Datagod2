import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listAllBundles, createBundle, updateBundle, deleteBundle, validateBundleInput } from "@/lib/sms/bundle-service"
import { adminGuard } from "@/lib/sms/admin-guard"

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  return NextResponse.json({ bundles: await listAllBundles() })
}
export async function POST(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const body = await request.json()
  if (!body.name || !body.units || body.price_ghs == null) return NextResponse.json({ error: "name, units, price_ghs required" }, { status: 400 })
  const invalid = validateBundleInput({ units: body.units, price_ghs: body.price_ghs })
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
  try {
    return NextResponse.json({ bundle: await createBundle(body) })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("mode must be")) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
}
export async function PATCH(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const { id, ...patch } = body
  const invalid = validateBundleInput({ units: patch.units, price_ghs: patch.price_ghs })
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
  try {
    return NextResponse.json({ bundle: await updateBundle(id, patch) })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("mode must be")) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
}

// DELETE ?id=<bundle id> — guarded hard delete (inactive for ≥ 48 h)
export async function DELETE(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const id = request.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const r = await deleteBundle(g.adminId!, id)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "Bundle not found" ? 404 : 400 })
  return NextResponse.json({ success: true })
}
