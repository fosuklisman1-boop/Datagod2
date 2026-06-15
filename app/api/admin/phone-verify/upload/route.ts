import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { normalizeGhanaPhoneNumber } from "@/lib/phone-validation"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_FILE_SIZE = 50 * 1024 * 1024

function extractPhoneColumn(rows: string[][]): string[] {
  if (rows.length === 0) return []
  const header = rows[0].map(h => h.toLowerCase().trim())
  // Find "Phone Number" column; fall back to column 0
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

function detectNetwork(phone: string): string {
  const n = normalizeGhanaPhoneNumber(phone)
  if (!n || n.length !== 10) return "UNKNOWN"
  const p = n.substring(0, 3)
  if (p === "020" || p === "050") return "TELECEL"
  if (["026", "027", "056", "057"].includes(p)) return "AT"
  if (["024", "025", "054", "055", "059"].includes(p)) return "MTN"
  return "UNKNOWN"
}

// Returns the subset of `candidates` already present in phone_verification_results
// (from ANY earlier session), mapped to the best account name previously seen for
// that number (null if it was only ever invalid/pending). Stored and candidate
// numbers are both normalized, so equality matching is safe. Chunked + paginated
// so it scales regardless of how many candidates or historical rows exist.
async function findExistingNumbers(candidates: string[]): Promise<Map<string, string | null>> {
  const existing = new Map<string, string | null>()
  const CHUNK = 500
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    let from = 0
    while (true) {
      // order by the unique primary key so offset pagination is stable even when a
      // number recurs across many sessions (name preference is handled in the Map)
      const { data, error } = await supabase
        .from("phone_verification_results")
        .select("phone_number, account_name")
        .in("phone_number", chunk)
        .order("id", { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`Duplicate lookup failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        // record once; upgrade to a non-null name if a later row has one
        if (!existing.has(row.phone_number) || (row.account_name && existing.get(row.phone_number) == null)) {
          existing.set(row.phone_number, row.account_name ?? null)
        }
      }
      if (data.length < 1000) break
      from += 1000
    }
  }
  return existing
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
    if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: "File exceeds 50 MB limit" }, { status: 400 })
    if (!file.name.match(/\.(csv|xlsx|xls)$/i)) {
      return NextResponse.json({ error: "Only .csv and .xlsx files are supported" }, { status: 400 })
    }

    const phoneLines = await fileToPhoneLines(file)
    if (phoneLines.length === 0) return NextResponse.json({ error: "No phone numbers found in file" }, { status: 400 })

    const phones = [...new Set(phoneLines.map(normalizeGhanaPhoneNumber).filter(p => p.length >= 9))]

    // Numbers already uploaded in a previous session are flagged as duplicates and
    // skipped from verification (the processor only picks up `pending` rows).
    const existing = await findExistingNumbers(phones)
    const duplicates = phones.filter(p => existing.has(p)).length
    const newCount = phones.length - duplicates

    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .insert({ file_name: file.name, total_count: phones.length, status: "processing", created_by: userId })
      .select("id")
      .single()

    if (sessionError || !session) throw new Error(`Session creation failed: ${sessionError?.message}`)

    const rows = phones.map(phone => {
      const isDuplicate = existing.has(phone)
      return {
        session_id: session.id,
        phone_number: phone,
        network: detectNetwork(phone),
        account_name: isDuplicate ? (existing.get(phone) ?? null) : null,
        status: isDuplicate ? "duplicate" : "pending",
      }
    })

    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await supabase.from("phone_verification_results").insert(rows.slice(i, i + 1000))
      if (error) throw new Error(`Bulk insert failed at offset ${i}: ${error.message}`)
    }

    return NextResponse.json({ sessionId: session.id, total: phones.length, newCount, duplicates })
  } catch (error) {
    console.error("[PHONE-VERIFY-UPLOAD]", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
