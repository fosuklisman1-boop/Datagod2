import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { normalizeGhanaPhoneNumber } from "@/lib/phone-validation"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_FILE_SIZE = 50 * 1024 * 1024

async function fileToPhoneLines(file: File): Promise<string[]> {
  let text: string
  if (file.name.match(/\.xlsx?$/i)) {
    const { read, utils } = await import("xlsx")
    const buf = await file.arrayBuffer()
    const wb = read(buf, { type: "array" })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" })
    text = rows.map(r => String(r[0] ?? "")).join("\n")
  } else {
    text = await file.text()
  }
  return text
    .split(/[\r\n]+/)
    .map(line => line.split(",")[0].trim())
    .filter(Boolean)
}

export function detectNetwork(phone: string): string {
  const n = normalizeGhanaPhoneNumber(phone)
  if (!n || n.length !== 10) return "UNKNOWN"
  const p = n.substring(0, 3)
  if (p === "020" || p === "050") return "TELECEL"
  if (["026", "027", "056", "057"].includes(p)) return "AT"
  if (["024", "025", "054", "055", "059"].includes(p)) return "MTN"
  return "UNKNOWN"
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

    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .insert({ file_name: file.name, total_count: phones.length, status: "processing", created_by: userId })
      .select("id")
      .single()

    if (sessionError || !session) throw new Error(`Session creation failed: ${sessionError?.message}`)

    const rows = phones.map(phone => ({
      session_id: session.id,
      phone_number: phone,
      network: detectNetwork(phone),
      status: "pending",
    }))

    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await supabase.from("phone_verification_results").insert(rows.slice(i, i + 1000))
      if (error) throw new Error(`Bulk insert failed at offset ${i}: ${error.message}`)
    }

    return NextResponse.json({ sessionId: session.id, total: phones.length })
  } catch (error) {
    console.error("[PHONE-VERIFY-UPLOAD]", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
