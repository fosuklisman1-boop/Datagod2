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

      // Now safe to create the auth user. Carry the profile fields as
      // user_metadata and set emailRedirectTo so that when email confirmation is
      // ON, the confirmation link routes through /auth/callback — which finalizes
      // the profile from this metadata. When confirmation is OFF we finalize
      // immediately below (a session already exists).
      const emailRedirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : undefined

      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: userData.first_name,
            last_name: userData.last_name,
            phone_number: userData.phone_number,
          },
          ...(emailRedirectTo ? { emailRedirectTo } : {}),
        },
      })

      if (authError) throw authError

      if (!authData.user) throw new Error("User creation failed")

      // Email confirmation ON → no session until the user clicks the link. Do NOT
      // throw: surface a "confirmation required" result so the page can tell the
      // user to check their email. The /auth/callback handler finalizes the
      // profile (name/phone/OTP/wallet) once they confirm.
      if (!authData.session?.access_token) {
        return { user: authData.user, profile: null, confirmationRequired: true }
      }

      // Email confirmation OFF (autoconfirm) → finalize the profile now via the
      // service-role route, passing the session token for identity verification.
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
      return { user: authData.user, profile: profileData.profile, confirmationRequired: false }
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
