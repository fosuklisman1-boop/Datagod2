import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Temporary endpoint to run migrations
 * Should only be used for database schema updates
 * Delete after running the migration
 */
export async function POST(request: NextRequest) {
  try {
    // Security check - in production, this should verify a migration token
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { migration } = await request.json()

    if (!migration) {
      return NextResponse.json(
        { error: "Migration name required" },
        { status: 400 }
      )
    }

    console.log(`[MIGRATION] Running: ${migration}`)

    // Add fee column to wallet_payments table
    if (migration === "add_fee_column") {
      const { error } = await supabase.rpc("execute_sql", {
        sql: `
          ALTER TABLE wallet_payments
          ADD COLUMN IF NOT EXISTS fee DECIMAL(10, 2) DEFAULT 0;
        `,
      })

      if (error && !error.message.includes("already exists")) {
        throw error
      }

      return NextResponse.json({
        success: true,
        message: "Fee column added to wallet_payments table",
      })
    }

    return NextResponse.json(
      { error: "Unknown migration" },
      { status: 400 }
    )
  } catch (error) {
    console.error("[MIGRATION] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Migration failed" },
      { status: 500 }
    )
  }
}
