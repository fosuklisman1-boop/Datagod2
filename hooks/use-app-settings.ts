import { useState, useEffect } from "react"

export interface AppSettings {
  id: string | null
  join_community_link: string
  created_at: string | null
  updated_at: string | null
}

export const useAppSettings = () => {
  const [settings, setSettings] = useState<AppSettings>({
    id: null,
    join_community_link: "",
    created_at: null,
    updated_at: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await fetch("/api/admin/settings")
        if (!response.ok) {
          throw new Error("Failed to fetch settings")
        }
        const data = await response.json()
        setSettings(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error")
        console.error("[APP-SETTINGS] Error fetching settings:", err)
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()

    // Refresh every 60 seconds
    const interval = setInterval(fetchSettings, 60000)

    return () => clearInterval(interval)
  }, [])

  return {
    settings,
    loading,
    error,
    joinCommunityLink: settings.join_community_link,
  }
}
