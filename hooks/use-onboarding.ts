"use client"

import { useState, useEffect } from "react"
import { useAuth } from "./use-auth"
import { supabase } from "@/lib/supabase"

interface UseOnboardingReturn {
  showOnboarding: boolean
  isLoading: boolean
  completeOnboarding: () => Promise<void>
  skipOnboarding: () => Promise<void>
  error: string | null
}

export function useOnboarding(): UseOnboardingReturn {
  const { user, loading: authLoading } = useAuth()
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const checkOnboardingStatus = async () => {
      // Wait for auth to load
      if (authLoading) {
        return
      }

      // User not logged in
      if (!user) {
        setIsLoading(false)
        return
      }

      try {
        setIsLoading(true)

        // Fetch user's onboarding status
        const { data, error: fetchError } = await supabase
          .from("users")
          .select("onboarding_completed")
          .eq("id", user.id)
          .single()

        if (fetchError) {
          console.error("Error fetching onboarding status:", fetchError)
          setError(fetchError.message)
          setIsLoading(false)
          return
        }

        // Show onboarding if not completed
        setShowOnboarding(!data?.onboarding_completed)
        setIsLoading(false)
      } catch (err: any) {
        console.error("Error checking onboarding:", err)
        setError(err?.message || "Failed to check onboarding status")
        setIsLoading(false)
      }
    }

    checkOnboardingStatus()
  }, [user, authLoading])

  const completeOnboarding = async () => {
    if (!user) return

    try {
      setIsLoading(true)
      
      // Call API to mark onboarding as complete
      const response = await fetch("/api/user/complete-onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to complete onboarding")
      }

      // Update local state
      setShowOnboarding(false)
      setIsLoading(false)
    } catch (err: any) {
      console.error("Error completing onboarding:", err)
      setError(err?.message || "Failed to complete onboarding")
      setIsLoading(false)
      throw err
    }
  }

  const skipOnboarding = async () => {
    // Skip = complete onboarding
    return completeOnboarding()
  }

  return {
    showOnboarding,
    isLoading,
    completeOnboarding,
    skipOnboarding,
    error,
  }
}
