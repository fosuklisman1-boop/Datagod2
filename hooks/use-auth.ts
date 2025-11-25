import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import type { User, Session } from "@supabase/supabase-js"

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const router = useRouter()

  useEffect(() => {
    // Get initial session
    const getSession = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession()

        if (error) throw error

        setSession(session)
        setUser(session?.user ?? null)
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to get session"))
      } finally {
        setLoading(false)
      }
    }

    getSession()

    // Subscribe to auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

    return () => {
      subscription?.unsubscribe()
    }
  }, [])

  const login = async (email: string, password: string) => {
    try {
      setLoading(true)
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (error) throw error

      setUser(data.user)
      setSession(data.session)
      router.push("/dashboard")
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Login failed")
      setError(error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  const signUp = async (email: string, password: string, userData?: any) => {
    try {
      setLoading(true)
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      })

      if (error) throw error

      setUser(data.user)
      setSession(data.session)
      // Don't redirect yet - user needs to verify email
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Sign up failed")
      setError(error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    try {
      setLoading(true)
      const { error } = await supabase.auth.signOut()

      if (error) throw error

      setUser(null)
      setSession(null)
      router.push("/auth/login")
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Logout failed")
      setError(error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  const resetPassword = async (email: string) => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/reset-password`,
      })

      if (error) throw error
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Password reset failed")
      setError(error)
      throw error
    }
  }

  return {
    user,
    session,
    loading,
    error,
    login,
    signUp,
    logout,
    resetPassword,
    isAuthenticated: !!user,
  }
}
