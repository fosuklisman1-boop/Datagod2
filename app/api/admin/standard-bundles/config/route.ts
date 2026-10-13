import { NextRequest, NextResponse } from "next/server"
import { getBundlesConfig, setBundlesConfig, validateBundlesPatch } from "@/lib/standard-bundles/config"
import { BUNDLE_NETWORKS, CATEGORY_ORDER, OTHER_CATEGORY } from "@/lib/standard-bundles/categories"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

const categories = () => Object.fromEntries(BUNDLE_NETWORKS.map(n => [n, [...CATEGORY_ORDER[n], OTHER_CATEGORY]]))

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  try {
    const { db } = getHubtelCsRuntime()
    return NextResponse.json({ config: await getBundlesConfig(db), categories: categories() })
  } catch (e) {
    return errorJson(e)
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to change settings" }, { status: 403 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const v = validateBundlesPatch(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  try {
    const { db } = getHubtelCsRuntime()
    const before = await getBundlesConfig(db).catch(() => null)
    const config = await setBundlesConfig(db, v.patch)
    auditLog(db, { adminId: auth.userId, action: "standard_bundles_config", oldValue: before, newValue: config })
    return NextResponse.json({ config, categories: categories() })
  } catch (e) {
    return errorJson(e)
  }
}
