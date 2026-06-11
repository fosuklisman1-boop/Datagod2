import { supabase } from "./supabase"

export const authService = {
  async signUp(email: string, password: string, userData: any) {
    try {
      // FIRST: Check if phone number already exists (before creating auth user)
      const phoneCheckResponse = await fetch("/api/auth/check-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: userData.phone_number }),
      })

      // check-phone always returns HTTP 200; availability is in the response body.
      const phoneCheckData = await phoneCheckResponse.json()
      if (!phoneCheckData.available) {
        throw new Error(phoneCheckData.error || "Phone number validation failed")
      }

      // Now safe to create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
      })

      if (authError) throw authError

      if (!authData.user) throw new Error("User creation failed")

      // Create user profile via API route (server-side)
      // Send the session token so the server can verify the identity server-side
      if (!authData.session?.access_token) {
        throw new Error("No session token after signup — email confirmation may be required")
      }

      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authData.session.access_token}`,
        },
        body: JSON.stringify({
          email,
          firstName: userData.first_name,
          lastName: userData.last_name,
          phoneNumber: userData.phone_number,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to create user profile")
      }

      const profileData = await response.json()
      return { user: authData.user, profile: profileData.profile }
    } catch (error) {
      console.error("Sign up error:", error)
      throw error
    }
  },

  async login(email: string, password: string) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (error) throw error

      return data
    } catch (error) {
      console.error("Login error:", error)
      throw error
    }
  },

  async logout() {
    try {
      // Local scope: log out this device only. Global scope killed the user's
      // sessions on every device, leaving other devices with unexpired JWTs
      // that fail server-side getUser() (session_not_found → 401 Unauthorized).
      const { error } = await supabase.auth.signOut({ scope: "local" })
      if (error) throw error
    } catch (error) {
      console.error("Logout error:", error)
      throw error
    }
  },

  async resetPassword(email: string) {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/reset-password`,
      })

      if (error) throw error
    } catch (error) {
      console.error("Password reset error:", error)
      throw error
    }
  },

  async updatePassword(newPassword: string) {
    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (error) throw error
    } catch (error) {
      console.error("Update password error:", error)
      throw error
    }
  },

  async getCurrentUser() {
    try {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser()

      if (error) {
        // AuthSessionMissingError fires for every unauthenticated page load — not a bug.
        if (error.message?.includes("Auth session missing")) return null
        throw error
      }
      return user
    } catch (error) {
      console.error("Get current user error:", error)
      return null
    }
  },

  async getSession() {
    try {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession()

      if (error) throw error
      return session
    } catch (error) {
      console.error("Get session error:", error)
      return null
    }
  },
}
