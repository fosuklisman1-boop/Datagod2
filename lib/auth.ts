import { supabase } from "./supabase"
import { userService } from "./database"

export const authService = {
  async signUp(email: string, password: string, userData: any) {
    try {
      // Sign up with Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
      })

      if (authError) throw authError

      if (!authData.user) throw new Error("User creation failed")

      // Create user profile
      const userProfile = await userService.createUser({
        id: authData.user.id,
        email,
        ...userData,
        created_at: new Date().toISOString(),
      })

      return { user: authData.user, profile: userProfile }
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
      const { error } = await supabase.auth.signOut()
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

      if (error) throw error
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
