import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

/**
 * Get current user session
 * Returns the access token for authenticated requests
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient(supabaseUrl, anonKey)
    
    // Get the session from cookies or auth header
    const { data: { session }, error } = await supabase.auth.getSession()

    if (error || !session) {
      return NextResponse.json(
        { data: { session: null } },
        { status: 200 }
      )
    }

    return NextResponse.json(
      { 
        data: { 
          session: {
            access_token: session.access_token,
            user: session.user
          }
        }
      },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("[AUTH-SESSION] Error:", error)
    return NextResponse.json(
      { data: { session: null } },
      { status: 200 }
    )
  }
}
