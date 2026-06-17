"use client"

import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { BottomNav } from "./bottom-nav"
import { AnnouncementModal } from "@/components/announcement-modal"
import { PhoneRequiredModal } from "@/components/phone-required-modal"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
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
  const router = useRouter()

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
        if (cancelled) return
        if (cfg?.phone_gate_disabled === true) {
          console.info("[phone-gate] off — kill switch (admin_settings.phone_gate_disabled) is ON")
          return
        }

        const { data: { session } } = await supabase.auth.getSession()
        if (cancelled || !session?.access_token) return

        // AUTHORITATIVE profile read via /api/user/me (service_role). Only this
        // source is trusted for the ROUTING decision below — a direct authenticated
        // read can falsely report "no row" under RLS, which is what caused the old
        // dashboard ⇄ complete-profile loop.
        let me: { exists: boolean; hasPhone: boolean; phoneVerified: boolean | null; phoneVerifyDeadline: string | null } | null = null
        const res = await fetch("/api/user/me", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        }).catch(() => null)
        if (res?.ok) {
          const body: any = await res.json().catch(() => null)
          if (body) me = {
            exists: !!body.exists,
            hasPhone: !!body.hasPhone,
            phoneVerified: body.phoneVerified ?? null,
            phoneVerifyDeadline: body.phoneVerifyDeadline ?? null,
          }
        } else if (res) {
          const body: any = await res.json().catch(() => ({}))
          console.warn(`[phone-gate] /api/user/me -> ${res.status}`, body?.code || body?.error || "", "— if 42501/500, apply migration 0057 (service_role GRANT).")
        }
        if (cancelled) return

        if (me) {
          if (!me.exists) {
            // Logged in but NO public.users row (an email login that skipped the
            // OAuth callback, an abandoned signup, or a deleted row). Route to
            // complete-profile to create it. No loop risk: this "no row" is the
            // authoritative service_role answer, so complete-profile agrees and
            // won't bounce back.
            console.info("[phone-gate] no public.users row → routing to complete-profile")
            router.replace("/auth/complete-profile")
            return
          }
          // Gate signal — match the server guard (lib/phone-verify-guard) and the
          // DB trigger: block when NOT phone_verified AND the grace deadline has
          // passed. If the phone_verified columns aren't available (older DB),
          // fall back to the phone-number presence check.
          if (me.phoneVerified === null) {
            if (!me.hasPhone) setShowPhoneRequired(true)
          } else {
            const inGrace = me.phoneVerifyDeadline && new Date(me.phoneVerifyDeadline) > new Date()
            if (me.phoneVerified !== true && !inGrace) setShowPhoneRequired(true)
          }
          return
        }

        // /api/user/me unavailable — fall back to a direct read for the GATE ONLY.
        // Never redirect on this path (an authenticated read can falsely return 0
        // rows under RLS, and redirecting on that would loop).
        const { data: profile, error } = await supabase
          .from("users").select("phone_number").eq("id", user.id).maybeSingle()
        if (error) console.warn("[phone-gate] fallback read failed:", error.code, error.message)
        else if (profile && !profile.phone_number) setShowPhoneRequired(true)
        else if (!profile) console.warn("[phone-gate] fallback read returned no row — NOT redirecting (could be RLS). Apply migration 0057 so /api/user/me works.")
      } catch (e) { console.warn("[phone-gate] error:", e) }
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
    <div className={`flex h-screen overflow-hidden transition-colors duration-300 ${isDealer ? "bg-primary/40 dark:bg-primary/20" : "bg-background"}`}>
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
