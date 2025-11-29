"use client"

import { useAppSettings } from "@/hooks/use-app-settings"
import { Button } from "@/components/ui/button"
import { Users } from "lucide-react"

export function JoinCommunityButton() {
  const { joinCommunityLink, loading } = useAppSettings()

  if (loading || !joinCommunityLink) {
    return null
  }

  return (
    <Button
      asChild
      variant="outline"
      className="w-full gap-2 justify-center border-violet-200 hover:bg-violet-50 text-violet-700 hover:text-violet-800"
    >
      <a href={joinCommunityLink} target="_blank" rel="noopener noreferrer">
        <Users className="w-4 h-4" />
        Join Community
      </a>
    </Button>
  )
}
