import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { requireHubAdmin, badRequest, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

const PAGE_SIZE = 50
const MAX_PAGE = 1000
const Q_MAX = 64

/**
 * q goes into a PostgREST .or() filter string, so it is reduced to a safe alphabet first (no comma, paren, quote,
 * backslash), then % and _ are escaped for ilike, and the value is double-quoted. "" means no search.
 */
function searchTerm(q: string | null): string {
  return (q ?? "").trim().slice(0, Q_MAX).replace(/[^A-Za-z0-9 @+._-]/g, "")
}

function searchFilter(term: string): string {
  // Inside a PostgREST double-quoted value "\\" is one backslash, so "\\%" reaches ilike as the escaped "\%".
  const escaped = term.replace(/[%_]/g, (c) => `\\\\${c}`)
  const value = `"%${escaped}%"`
  return ["first_name", "last_name", "email", "phone_number"].map((c) => `${c}.ilike.${value}`).join(",")
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const url = new URL(request.url)
    const n = Number.parseInt(url.searchParams.get("page") ?? "1", 10)
    const page = Math.min(MAX_PAGE, Math.max(1, Number.isFinite(n) ? n : 1))
    const term = searchTerm(url.searchParams.get("q"))

    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })

    let query = db
      .from("users")
      .select("id, first_name, last_name, email, phone_number", { count: "exact" })
    // Users with no role count as "user" everywhere else.
    query = target.slug === "user" ? query.or("role.is.null,role.eq.user") : query.eq("role", target.slug)
    if (term) query = query.or(searchFilter(term))
    const from = (page - 1) * PAGE_SIZE
    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error || !Array.isArray(data)) {
      console.error("[ROLES-HUB] members read failed")
      return serverError()
    }
    const members = (data as { id: string; first_name: string | null; last_name: string | null; email: string | null; phone_number: string | null }[]).map(
      (u) => ({
        id: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(" "),
        email: u.email,
        phone: u.phone_number,
      }),
    )
    return NextResponse.json({ members, total: count ?? members.length, page })
  } catch {
    console.error("[ROLES-HUB] members failed")
    return serverError()
  }
}
