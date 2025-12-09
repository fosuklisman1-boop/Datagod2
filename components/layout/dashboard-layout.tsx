"use client"

import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { AnnouncementModal } from "@/components/announcement-modal"
import { useState, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false)
  const [showAnnouncement, setShowAnnouncement] = useState(false)
  const [announcementTitle, setAnnouncementTitle] = useState("")
  const [announcementMessage, setAnnouncementMessage] = useState("")
  const { user } = useAuth()

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  // Load announcement settings on mount
  useEffect(() => {
    if (!user) return

    const fetchAnnouncement = async () => {
      try {
        // Check if user has already seen this announcement in this session
        const sessionKey = `announcement_seen_${user.id}`
        const hasSeenInSession = sessionStorage.getItem(sessionKey)
        
        if (hasSeenInSession) {
          return
        }

        const response = await fetch("/api/admin/settings")
        const data = await response.json()

        if (data.announcement_enabled && data.announcement_title && data.announcement_message) {
          setAnnouncementTitle(data.announcement_title)
          setAnnouncementMessage(data.announcement_message)
          setShowAnnouncement(true)
        }
      } catch (error) {
        console.error("Error fetching announcement:", error)
      }
    }

    fetchAnnouncement()
  }, [user])

  const handleCloseAnnouncement = () => {
    setShowAnnouncement(false)
    // Mark as seen in this session so it won't show again until next login
    if (user) {
      sessionStorage.setItem(`announcement_seen_${user.id}`, "true")
    }
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden transition-all duration-300">
        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="flex-1 overflow-auto md:overflow-y-auto md:overflow-x-hidden pt-16 md:pt-0 p-2 sm:p-3 md:p-4 lg:p-6">
          <div className="w-full max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>

      {/* Announcement Modal */}
      <AnnouncementModal
        isOpen={showAnnouncement}
        onClose={handleCloseAnnouncement}
        title={announcementTitle}
        message={announcementMessage}
      />
    </div>
  )
}
