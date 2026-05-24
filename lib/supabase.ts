import { createBrowserClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ""

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Missing Supabase environment variables")
}

// Cookie-based session storage so the middleware can read the session server-side
// and enforce route guards without a client-side redirect round-trip.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey)

// Admin client — server-side only, never exposed to the browser bundle.
export const supabaseAdmin = supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : supabase

export default supabase
