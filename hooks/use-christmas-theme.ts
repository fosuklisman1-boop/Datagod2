import { useEffect, useState, useCallback } from "react"
import { toast } from "sonner"

export const useChristmasTheme = () => {
  const [isChristmasEnabled, setIsChristmasEnabled] = useState(false)
  const [loading, setLoading] = useState(true)

  // Fetch Christmas theme setting
  useEffect(() => {
    const fetchThemeSetting = async () => {
      try {
        const response = await fetch("/api/admin/christmas-theme")
        if (response.ok) {
          const data = await response.json()
          setIsChristmasEnabled(data.christmas_theme_enabled || false)
          // Store in localStorage for quick access
          localStorage.setItem(
            "christmas_theme_enabled",
            JSON.stringify(data.christmas_theme_enabled)
          )
        }
      } catch (error) {
        console.error("Error fetching Christmas theme setting:", error)
      } finally {
        setLoading(false)
      }
    }

    // Check localStorage first for faster load
    const stored = localStorage.getItem("christmas_theme_enabled")
    if (stored) {
      setIsChristmasEnabled(JSON.parse(stored))
      setLoading(false)
    }

    // Then fetch from server
    fetchThemeSetting()
  }, [])

  // Apply theme to document
  useEffect(() => {
    if (isChristmasEnabled) {
      document.documentElement.classList.add("christmas-theme")
    } else {
      document.documentElement.classList.remove("christmas-theme")
    }
  }, [isChristmasEnabled])

  const toggleChristmasTheme = useCallback(
    async (enabled: boolean) => {
      try {
        const { data: { session } } = await (
          await import("@/lib/supabase")
        ).supabase.auth.getSession()

        if (!session?.access_token) {
          toast.error("Authentication required")
          return false
        }

        const response = await fetch("/api/admin/christmas-theme", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ christmas_theme_enabled: enabled }),
        })

        if (!response.ok) {
          const error = await response.json()
          throw new Error(error.error || "Failed to update theme")
        }

        setIsChristmasEnabled(enabled)
        localStorage.setItem(
          "christmas_theme_enabled",
          JSON.stringify(enabled)
        )
        toast.success(
          enabled
            ? "🎄 Christmas theme enabled!"
            : "Christmas theme disabled"
        )
        return true
      } catch (error) {
        console.error("Error toggling Christmas theme:", error)
        const errorMessage = error instanceof Error ? error.message : "Failed to update theme"
        toast.error(errorMessage)
        return false
      }
    },
    []
  )

  return {
    isChristmasEnabled,
    loading,
    toggleChristmasTheme,
  }
}
