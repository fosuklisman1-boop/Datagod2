import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const EXAM_BOARDS = ["WAEC", "BECE", "NOVDEC"]

export async function GET() {
  const results = await Promise.all(
    EXAM_BOARDS.map(board =>
      supabase
        .from("results_checker_inventory")
        .select("id", { count: "exact", head: true })
        .eq("exam_board", board)
        .eq("status", "available")
    )
  )

  const counts: Record<string, number> = {}
  EXAM_BOARDS.forEach((board, i) => {
    counts[board] = results[i].count ?? 0
  })

  return NextResponse.json({ counts })
}
