// Standalone whitelist check used by the admin progress dialog.
// Tries the specified provider first, then all other configured providers.
// Returns per-provider results so the UI can show each step.
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { WHITELIST_REGISTRY } from "@/lib/mtn-providers/provider-whitelist"
import { normalizeGhanaPhone } from "@/lib/phone-format"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { phone, primaryProvider } = await request.json()
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })

  const norm = normalizeGhanaPhone(phone) ?? phone
  const configured = WHITELIST_REGISTRY.filter(p => p.configured())

  if (configured.length === 0) {
    return NextResponse.json({
      phone: norm,
      results: [],
      allowed: true,
      allowedBy: null,
      note: "No whitelist providers configured — check passes by default",
    })
  }

  // Primary provider first, then the rest
  const ordered = [
    ...configured.filter(p => p.name === primaryProvider),
    ...configured.filter(p => p.name !== primaryProvider),
  ]

  const results: Array<{ provider: string; allowed: boolean; reason?: string }> = []
  let allowedBy: string | null = null

  for (const entry of ordered) {
    const result = await entry.check(norm).catch(() => ({ allowed: true, provider: entry.name }))
    results.push({ provider: entry.name, allowed: result.allowed, reason: (result as any).reason })
    if (result.allowed && !allowedBy) {
      allowedBy = entry.name
      break // stop as soon as one allows — matches runtime behavior
    }
  }

  return NextResponse.json({
    phone: norm,
    results,
    allowed: !!allowedBy,
    allowedBy,
  })
}
