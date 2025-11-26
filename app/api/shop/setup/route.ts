import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

export async function POST() {
  try {
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Check if user_shops table exists
    const { data, error } = await supabaseAdmin
      .from("user_shops")
      .select("count(*)", { count: "exact", head: true })

    if (error?.code === "42P01") {
      // Table doesn't exist
      return NextResponse.json(
        {
          status: "error",
          message: "Database tables not found. Please execute the SQL schema in Supabase.",
          instructions: "Copy lib/shop-schema.sql and run it in Supabase SQL Editor",
        },
        { status: 404 }
      )
    }

    if (error) {
      return NextResponse.json(
        { status: "error", message: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      status: "success",
      message: "Database tables are set up correctly",
    })
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
