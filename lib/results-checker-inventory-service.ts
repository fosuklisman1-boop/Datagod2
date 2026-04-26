import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface ParsedVoucher {
  exam_board: string
  pin: string
  serial_number?: string
  expiry_date?: string
  notes?: string
}

export interface ParseError {
  row: number
  reason: string
  raw: string
}

export interface ParseResult {
  valid: ParsedVoucher[]
  errors: ParseError[]
}

export interface UploadResult {
  batchId: string
  inserted: number
  skipped: number
}

export interface InventorySummary {
  waec: { available: number; reserved: number; sold: number; invalid: number; expired: number }
  bece: { available: number; reserved: number; sold: number; invalid: number; expired: number }
  novdec: { available: number; reserved: number; sold: number; invalid: number; expired: number }
}

const VALID_BOARDS = new Set(["WAEC", "BECE", "NOVDEC"])

export function parseVoucherCSV(text: string): ParseResult {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean)
  const valid: ParsedVoucher[] = []
  const errors: ParseError[] = []

  // Skip header row if present
  const startIdx = lines[0]?.toLowerCase().startsWith("exam_board") ? 1 : 0

  // Detect duplicates within the file itself
  const seenPins = new Map<string, number>()

  for (let i = startIdx; i < lines.length; i++) {
    const raw = lines[i]
    const cols = raw.split(",").map(c => c.trim())
    const [exam_board, pin, serial_number, expiry_date, notes] = cols
    const rowNum = i + 1

    if (!exam_board || !pin) {
      errors.push({ row: rowNum, reason: "Missing exam_board or pin", raw })
      continue
    }

    if (!VALID_BOARDS.has(exam_board.toUpperCase())) {
      errors.push({ row: rowNum, reason: `Invalid exam_board "${exam_board}". Must be WAEC, BECE, or NOVDEC`, raw })
      continue
    }

    if (pin.length < 4) {
      errors.push({ row: rowNum, reason: "PIN too short (minimum 4 characters)", raw })
      continue
    }

    const dupeKey = `${exam_board.toUpperCase()}:${pin}`
    if (seenPins.has(dupeKey)) {
      errors.push({ row: rowNum, reason: `Duplicate PIN in this file (first seen at row ${seenPins.get(dupeKey)})`, raw })
      continue
    }
    seenPins.set(dupeKey, rowNum)

    if (expiry_date && expiry_date !== "" && isNaN(Date.parse(expiry_date))) {
      errors.push({ row: rowNum, reason: `Invalid expiry_date "${expiry_date}". Use YYYY-MM-DD`, raw })
      continue
    }

    valid.push({
      exam_board: exam_board.toUpperCase(),
      pin,
      serial_number: serial_number || undefined,
      expiry_date: expiry_date || undefined,
      notes: notes || undefined,
    })
  }

  return { valid, errors }
}

export async function uploadVoucherBatch(
  rows: ParsedVoucher[],
  uploadedBy: string
): Promise<UploadResult> {
  const batchId = `BATCH-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`

  const records = rows.map(r => ({
    exam_board: r.exam_board,
    pin: r.pin,
    serial_number: r.serial_number ?? null,
    expiry_date: r.expiry_date ?? null,
    notes: r.notes ?? null,
    batch_id: batchId,
    uploaded_by: uploadedBy,
  }))

  // Insert in chunks of 500 to avoid request size limits
  let inserted = 0
  let skipped = 0
  const chunkSize = 500

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize)
    const { data, error } = await supabase
      .from("results_checker_inventory")
      .upsert(chunk, { onConflict: "exam_board,pin", ignoreDuplicates: true })
      .select("id")

    if (error) {
      console.error("[RC-INVENTORY] Chunk insert error:", error)
      skipped += chunk.length
    } else {
      inserted += data?.length ?? 0
      skipped += chunk.length - (data?.length ?? 0)
    }
  }

  return { batchId, inserted, skipped }
}

export async function getInventorySummary(): Promise<InventorySummary> {
  const { data } = await supabase
    .from("results_checker_inventory")
    .select("exam_board, status")

  const summary: InventorySummary = {
    waec:   { available: 0, reserved: 0, sold: 0, invalid: 0, expired: 0 },
    bece:   { available: 0, reserved: 0, sold: 0, invalid: 0, expired: 0 },
    novdec: { available: 0, reserved: 0, sold: 0, invalid: 0, expired: 0 },
  }

  for (const row of data ?? []) {
    const board = row.exam_board?.toLowerCase() as keyof InventorySummary
    const status = row.status as keyof typeof summary.waec
    if (summary[board] && status in summary[board]) {
      summary[board][status]++
    }
  }

  return summary
}

export async function markVouchersInvalid(ids: string[]): Promise<void> {
  await supabase
    .from("results_checker_inventory")
    .update({ status: "invalid", updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "available")  // only mark available ones; sold ones are untouched
}
