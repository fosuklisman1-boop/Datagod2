import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getPrefixValidationConfig, PREFIX_MAP_KEY } from "@/lib/network-prefix-config"

export const dynamic = "force-dynamic"

const NETWORKS = ["MTN", "TELECEL", "AT"] as const
type Net = (typeof NETWORKS)[number]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { map } = await getPrefixValidationConfig()
  return NextResponse.json({ map }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { network, prefix, action } = await request.json()
    if (!NETWORKS.includes(network)) {
      return NextResponse.json({ error: "network must be MTN, TELECEL or AT" }, { status: 400 })
    }
    if (action !== "add" && action !== "remove") {
      return NextResponse.json({ error: "action must be add or remove" }, { status: 400 })
    }
    // Accept "058" or "58"; store the significant 2 digits.
    const raw = String(prefix ?? "").trim()
    const sig = /^0\d{2}$/.test(raw) ? raw.slice(1) : raw
    if (!/^[2-9]\d$/.test(sig)) {
      return NextResponse.json({ error: "prefix must be 2 digits (e.g. 58 or 058), starting 2-9" }, { status: 400 })
    }

    const { map } = await getPrefixValidationConfig()

    if (action === "add") {
      const owner = (NETWORKS as readonly Net[]).find(n => map[n].includes(sig))
      if (owner && owner !== network) {
        return NextResponse.json(
          { error: `Prefix 0${sig} is already assigned to ${owner} — remove it there first.` },
          { status: 409 }
        )
      }
      if (!map[network as Net].includes(sig)) map[network as Net].push(sig)
    } else {
      if (!map[network as Net].includes(sig)) {
        return NextResponse.json({ error: `Prefix 0${sig} is not assigned to ${network}.` }, { status: 404 })
      }
      if (map[network as Net].length === 1) {
        return NextResponse.json({ error: `Cannot remove the last ${network} prefix.` }, { status: 400 })
      }
      map[network as Net] = map[network as Net].filter(p => p !== sig)
    }

    const { error } = await supabase
      .from("admin_settings")
      .upsert(
        {
          key: PREFIX_MAP_KEY,
          value: map,
          description: "Significant 2-digit prefix -> network map. Drives order-time prefix validation (TS) and gh_is_mtn (SQL).",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      )
    if (error) throw error

    // Audit: prefix map changes affect ordering + registry export.
    try {
      const { error: auditErr } = await supabase.from("admin_audit_log").insert([{
        admin_id: adminId || null,
        action: "network_prefix_" + action,
        new_value: { network, prefix: sig, map },
        created_at: new Date().toISOString(),
      }])
      if (auditErr) console.warn("[PREFIX-ADMIN] audit insert failed:", auditErr.message)
    } catch (auditErr) {
      console.warn("[PREFIX-ADMIN] audit insert threw:", auditErr)
    }

    return NextResponse.json({ ok: true, map })
  } catch (error) {
    console.error("[PREFIX-ADMIN] error:", error)
    return NextResponse.json({ error: "Failed to update prefixes" }, { status: 500 })
  }
}
