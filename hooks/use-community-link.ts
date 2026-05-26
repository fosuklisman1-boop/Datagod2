import { useEffect, useState } from "react"

const CACHE_KEY = "dg_community_link"

function getCached(): string | null {
  if (typeof window === "undefined") return null
  return sessionStorage.getItem(CACHE_KEY)
}

export function useCommunityLink() {
  const [communityLink, setCommunityLink] = useState<string>(() => getCached() ?? "")
  const [loading, setLoading] = useState<boolean>(() => getCached() === null)

  useEffect(() => {
    if (!loading) return
    fetch("/api/app-settings")
      .then((r) => r.json())
      .then((data) => {
        const link = data?.join_community_link ?? ""
        setCommunityLink(link)
        sessionStorage.setItem(CACHE_KEY, link)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { communityLink, loading }
}
