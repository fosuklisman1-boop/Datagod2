import { useEffect, useState } from "react"

export function useCommunityLink() {
  const [communityLink, setCommunityLink] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch("/api/app-settings")
      .then((r) => r.json())
      .then((data) => setCommunityLink(data?.join_community_link ?? ""))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { communityLink, loading }
}
