"use client"

import { useState, useEffect } from "react"
import { useAuth } from "./use-auth"
import { supabase } from "@/lib/supabase"

interface UseOnboardingReturn {
  showOnboarding: boolean
  isLoading: boolean
  completeOnboarding: () => Promise<void>
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

        // Check wallet balance directly from Supabase
        const { data, error } = await supabase
          .from("wallet")
          .select("balance")
          .eq("user_id", user.id)
          .maybeSingle()

        if (error) {
          console.error("Error checking onboarding:", error)
          // Default to showing onboarding if we can't check
          setShowOnboarding(true)
          setIsLoading(false)
          return
        }

        // Show onboarding if wallet balance is less than 5
        const balance = data?.balance || 0
        setShowOnboarding(balance < 5)
        setIsLoading(false)
      } catch (err: any) {
        console.error("Error checking onboarding:", err)
        // Default to showing onboarding if we can't check
        setShowOnboarding(true)
        setIsLoading(false)
      }
    }

    checkOnboardingStatus()
  }, [user, authLoading])

  const completeOnboarding = async () => {
    // Just close the modal - no database update
    // This way it shows again on next login
    setShowOnboarding(false)
  }

  return {
    showOnboarding,
    isLoading,
    completeOnboarding,
    error,
  }
}
