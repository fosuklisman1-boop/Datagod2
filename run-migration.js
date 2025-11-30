#!/usr/bin/env node
/**
 * Migration runner for adding fee column to wallet_payments table
 * Run with: node run-migration.js
 */

const { createClient } = require("@supabase/supabase-js")
const fs = require("fs")
const path = require("path")

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Error: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function runMigration() {
  try {
    console.log("🚀 Running migration: add_fee_to_wallet_payments.sql")

    const migrationFile = path.join(__dirname, "migrations", "add_fee_to_wallet_payments.sql")
    const sql = fs.readFileSync(migrationFile, "utf-8")

    console.log("📝 SQL to execute:")
    console.log(sql)
    console.log("\n⏳ Executing...")

    // Execute the migration
    const { data, error } = await supabase.rpc("execute_sql", { sql })

    if (error) {
      // Try executing it as a direct query instead
      console.log("Note: rpc method not available, attempting direct execution via admin API...")
      
      // For Supabase, we can use the query via the client directly
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/execute_sql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`,
          "apikey": serviceRoleKey,
        },
        body: JSON.stringify({ sql }),
      })

      if (!response.ok) {
        throw new Error(`Migration failed: ${response.statusText}`)
      }
    }

    console.log("✅ Migration executed successfully!")
    console.log("The 'fee' column has been added to wallet_payments table")

  } catch (error) {
    console.error("❌ Migration failed:", error.message)
    process.exit(1)
  }
}

runMigration()
