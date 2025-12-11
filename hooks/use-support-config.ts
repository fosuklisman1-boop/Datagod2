import { useEffect, useState } from "react"

interface SupportConfig {
  email: string
  phone: string
  whatsapp: string
  website: string
}

const DEFAULT_CONFIG: SupportConfig = {
  email: "support@datagod.com",
  phone: "+233 XXX XXX XXXX",
  whatsapp: "https://wa.me/233XXXXXXXXX",
  website: "https://datagod.com",
}

export function useSupportConfig() {
  const [config, setConfig] = useState<SupportConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        setLoading(true)
        const response = await fetch("/api/support-config")
        if (!response.ok) {
          throw new Error("Failed to fetch support config")
        }
        const data = await response.json()
        setConfig(data)
        setError(null)
      } catch (err) {
        console.error("Error fetching support config:", err)
        // Keep default config on error
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        setLoading(false)
      }
    }

    fetchConfig()
  }, [])

  return { config, loading, error }
}
