"use client"

import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { BottomNav } from "./bottom-nav"
import { AnnouncementModal } from "@/components/announcement-modal"
import { PhoneRequiredModal } from "@/components/phone-required-modal"
import { useState, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"
import { useUserRole } from "@/hooks/use-user-role"
import { supabase } from "@/lib/supabase"

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showAnnouncement, setShowAnnouncement] = useState(false)
  const [announcementTitle, setAnnouncementTitle] = useState("")
  const [announcementMessage, setAnnouncementMessage] = useState("")
  const [showPhoneRequired, setShowPhoneRequired] = useState(false)
  const { user } = useAuth()
  const { isDealer } = useUserRole()

  // Global, instant phone gate. A logged-in user with NO phone number is blocked
  // by the non-dismissable PhoneRequiredModal on EVERY dashboard page (this layout
  // wraps them all), so they can't navigate away to escape it.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        // Emergency kill switch first: an admin can disable the whole gate (no
        // deploy) if OTP delivery fails and users get locked out.
        const cfg: any = await fetch("/api/public/turnstile-status").then(r => r.ok ? r.json() : {}).catch(() => ({}))
        if (cancelled || cfg?.phone_gate_disabled === true) return

        const { data: profile } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", user.id)
          .single()
        if (!cancelled && profile && !profile.phone_number) setShowPhoneRequired(true)
      } catch { /* don't block the app on a transient error */ }
    })()
    return () => { cancelled = true }
  }, [user])

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
    if (!user) {
      console.log("[ANNOUNCEMENT] No user, skipping announcement fetch")
      return
    }

    const fetchAnnouncement = async () => {
      try {
        console.log("[ANNOUNCEMENT] Fetching announcement settings...")
        const response = await fetch(`/api/settings/public?t=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
          },
        })
        const data = await response.json()

        console.log("[ANNOUNCEMENT] Settings response:", {
          announcement_enabled: data.announcement_enabled,
          announcement_title: data.announcement_title,
          announcement_message: data.announcement_message,
          fullData: data
        })

        if (data.announcement_enabled && data.announcement_title && data.announcement_message) {
          console.log("[ANNOUNCEMENT] Announcement is enabled and has content")
          // Create a unique key based on the announcement content
          // This ensures users see new announcements even if they've dismissed previous ones
          const announcementHash = btoa(unescape(encodeURIComponent(`${data.announcement_title}:${data.announcement_message}`))).substring(0, 16)
          const sessionKey = `announcement_seen_${user.id}_${announcementHash}`

          console.log("[ANNOUNCEMENT] Session key:", sessionKey)

          // Check if user has already seen THIS specific announcement in this session
          const hasSeenInSession = sessionStorage.getItem(sessionKey)

          if (hasSeenInSession) {
            console.log("[ANNOUNCEMENT] User has already seen this announcement in this session")
            return
          }

          console.log("[ANNOUNCEMENT] Showing announcement modal")
          setAnnouncementTitle(data.announcement_title)
          setAnnouncementMessage(data.announcement_message)
          setShowAnnouncement(true)

          // Store the session key for later use when closing
          sessionStorage.setItem("current_announcement_key", sessionKey)
        } else {
          console.log("[ANNOUNCEMENT] Announcement not enabled or missing content")
        }
      } catch (error) {
        console.error("[ANNOUNCEMENT] Error fetching announcement:", error)
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
    <>
    <div className={`flex h-screen overflow-hidden transition-colors duration-300 ${isDealer ? "bg-amber-50/40" : "bg-gray-50"}`}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content - add left margin for fixed sidebar */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${!isMobile ? (sidebarOpen ? 'md:ml-64' : 'md:ml-20') : ''}`}>
        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="flex-1 overflow-auto md:overflow-y-auto md:overflow-x-hidden pt-safe-header p-2 sm:p-3 md:p-4 lg:p-6 pb-24 md:pb-6">
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

    {/* Outside all overflow-hidden/transition ancestors so position:fixed
        stays viewport-relative and doesn't scroll with the page on mobile */}
    <BottomNav />

    {/* Non-dismissable: a user with no phone must add one before using the app. */}
    <PhoneRequiredModal
      open={showPhoneRequired}
      onPhoneSaved={() => setShowPhoneRequired(false)}
    />
    </>
  )
}
