import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { normalizeGhanaPhoneNumber } from "@/lib/phone-validation"
import { detectNetworkWithMap } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { hasWhitelistProviders, validateProviderSelection } from "@/lib/mtn-providers/provider-whitelist"
import {
  findExistingMoolreNumbers,
  findRecentWhitelistChecks,
  buildMoolreRows,
  buildWhitelistRows,
} from "@/lib/phone-verify-upload"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_FILE_SIZE = 50 * 1024 * 1024

function extractPhoneColumn(rows: string[][]): string[] {
  if (rows.length === 0) return []
  const header = rows[0].map(h => h.toLowerCase().trim())
  const phoneCol = header.findIndex(h => h.includes("phone"))
  const col = phoneCol >= 0 ? phoneCol : 0
  const dataRows = phoneCol >= 0 ? rows.slice(1) : rows
  return dataRows.map(r => String(r[col] ?? "").trim()).filter(Boolean)
}

async function fileToPhoneLines(file: File): Promise<string[]> {
  if (file.name.match(/\.xlsx?$/i)) {
    const { read, utils } = await import("xlsx")
    const buf = await file.arrayBuffer()
    const wb = read(buf, { type: "array" })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" })
    return extractPhoneColumn(rows as string[][])
  }
  const text = await file.text()
  const rows = text.split(/[\r\n]+/).map(line => line.split(",").map(c => c.trim()))
  return extractPhoneColumn(rows)
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const checkType = formData.get("checkType") === "mtn_whitelist" ? "mtn_whitelist" : "moolre"

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
    if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: "File exceeds 50 MB limit" }, { status: 400 })
    if (!file.name.match(/\.(csv|xlsx|xls)$/i)) {
      return NextResponse.json({ error: "Only .csv and .xlsx files are supported" }, { status: 400 })
    }

    let whitelistProviders: string[] | null = null
    if (checkType === "mtn_whitelist") {
      if (!hasWhitelistProviders()) {
        return NextResponse.json(
          { error: "No MTN whitelist provider is configured (Xpress/CodeCraft/AgentPortalGH)" },
          { status: 400 }
        )
      }
      const requestedProviders = String(formData.get("providers") ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
      const validated = validateProviderSelection(requestedProviders)
      if (!validated.valid) {
        return NextResponse.json({ error: validated.error }, { status: 400 })
      }
      whitelistProviders = validated.providers
    }

    const phoneLines = await fileToPhoneLines(file)
    if (phoneLines.length === 0) return NextResponse.json({ error: "No phone numbers found in file" }, { status: 400 })

    const phones = [...new Set(phoneLines.map(normalizeGhanaPhoneNumber).filter(p => p.length >= 9))]

    const { map: prefixMap } = await getPrefixValidationConfig()
    const phoneInputs = phones.map(phone => ({ phone, network: detectNetworkWithMap(phone, prefixMap) }))

    let rows: ReturnType<typeof buildMoolreRows>
    let duplicates: number

    if (checkType === "mtn_whitelist") {
      const recent = await findRecentWhitelistChecks(supabase, phones, whitelistProviders!)
      duplicates = phones.filter(p => recent.has(p)).length
      rows = buildWhitelistRows(phoneInputs, recent)
    } else {
      const existing = await findExistingMoolreNumbers(supabase, phones)
      duplicates = phones.filter(p => existing.has(p)).length
      rows = buildMoolreRows(phoneInputs, existing)
    }

    const newCount = phones.length - duplicates

    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .insert({
        file_name: file.name,
        total_count: phones.length,
        status: "processing",
        created_by: userId,
        check_type: checkType,
        whitelist_providers: whitelistProviders,
      })
      .select("id")
      .single()

    if (sessionError || !session) throw new Error(`Session creation failed: ${sessionError?.message}`)

    const finalRows = rows.map(r => ({ ...r, session_id: session.id }))
    for (let i = 0; i < finalRows.length; i += 1000) {
      const { error } = await supabase.from("phone_verification_results").insert(finalRows.slice(i, i + 1000))
      if (error) throw new Error(`Bulk insert failed at offset ${i}: ${error.message}`)
    }

    return NextResponse.json({ sessionId: session.id, total: phones.length, newCount, duplicates, checkType, whitelistProviders })
  } catch (error) {
    console.error("[PHONE-VERIFY-UPLOAD]", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
