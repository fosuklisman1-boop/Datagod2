import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listAllBundles, createBundle, updateBundle } from "@/lib/sms/bundle-service"

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  return NextResponse.json({ bundles: await listAllBundles() })
}
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const body = await request.json()
  if (!body.name || !body.units || body.price_ghs == null) return NextResponse.json({ error: "name, units, price_ghs required" }, { status: 400 })
  return NextResponse.json({ bundle: await createBundle(body) })
}
export async function PATCH(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const { id, ...patch } = body
  return NextResponse.json({ bundle: await updateBundle(id, patch) })
}
