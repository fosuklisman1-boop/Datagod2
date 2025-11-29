import { supabase } from "./supabase"

/**
 * Refresh the current user's session to get updated JWT with new role information
 * This is needed after role changes in the admin panel
 */
export async function refreshUserSession() {
  try {
    const { data: { session }, error } = await supabase.auth.refreshSession()
    
    if (error) {
      console.error("[SESSION-REFRESH] Error refreshing session:", error)
      return false
    }

    if (session) {
      console.log("[SESSION-REFRESH] Session refreshed successfully")
      return true
    }

    return false
  } catch (error) {
    console.error("[SESSION-REFRESH] Unexpected error:", error)
    return false
  }
}

/**
 * Force logout the user (useful after role changes if refresh fails)
 */
export async function forceLogout() {
  try {
    await supabase.auth.signOut()
    return true
  } catch (error) {
    console.error("[SESSION-REFRESH] Error logging out:", error)
    return false
  }
}
