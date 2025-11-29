import { useEffect, useState } from "react"

interface ShopSettings {
  whatsapp_link?: string
  id?: string
  shop_id?: string
  created_at?: string
  updated_at?: string
}

export function useShopSettings(shopId: string | undefined) {
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!shopId) {
      setLoading(false)
      return
    }

    const fetchSettings = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/shop/settings/${shopId}`)

        if (!response.ok) {
          throw new Error("Failed to fetch shop settings")
        }

        const data = await response.json()
        setSettings(data)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred")
        setSettings(null)
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [shopId])

  return { settings, loading, error }
}
