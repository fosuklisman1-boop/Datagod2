"use client"

import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { AnnouncementModal } from "@/components/announcement-modal"
import { useState, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
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

  // Listen for sidebar state changes
  useEffect(() => {
    const handleSidebarChange = (event: CustomEvent<{ isOpen: boolean; isMobile: boolean }>) => {
      setSidebarOpen(event.detail.isOpen)
    }

    window.addEventListener('sidebarStateChange', handleSidebarChange as EventListener)
    return () => window.removeEventListener('sidebarStateChange', handleSidebarChange as EventListener)
  }, [])

  // Load announcement settings on mount
  useEffect(() => {
    if (!user) return

    const fetchAnnouncement = async () => {
      try {
        const response = await fetch("/api/admin/settings")
        const data = await response.json()

        if (data.announcement_enabled && data.announcement_title && data.announcement_message) {
          // Create a unique key based on the announcement content
          // This ensures users see new announcements even if they've dismissed previous ones
          const announcementHash = btoa(unescape(encodeURIComponent(`${data.announcement_title}:${data.announcement_message}`))).substring(0, 16)
          const sessionKey = `announcement_seen_${user.id}_${announcementHash}`
          
          // Check if user has already seen THIS specific announcement in this session
          const hasSeenInSession = sessionStorage.getItem(sessionKey)
          
          if (hasSeenInSession) {
            return
          }

          setAnnouncementTitle(data.announcement_title)
          setAnnouncementMessage(data.announcement_message)
          setShowAnnouncement(true)
          
          // Store the session key for later use when closing
          sessionStorage.setItem("current_announcement_key", sessionKey)
        }
      } catch (error) {
        console.error("Error fetching announcement:", error)
      }
    }

    fetchAnnouncement()
  }, [user])

  const handleCloseAnnouncement = () => {
    setShowAnnouncement(false)
    // Mark this specific announcement as seen in this session
    const sessionKey = sessionStorage.getItem("current_announcement_key")
    if (sessionKey) {
      sessionStorage.setItem(sessionKey, "true")
    }
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content - add left margin for fixed sidebar */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${!isMobile ? (sidebarOpen ? 'md:ml-64' : 'md:ml-20') : ''}`}>
        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="flex-1 overflow-auto md:overflow-y-auto md:overflow-x-hidden pt-20 md:pt-20 p-2 sm:p-3 md:p-4 lg:p-6">
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
