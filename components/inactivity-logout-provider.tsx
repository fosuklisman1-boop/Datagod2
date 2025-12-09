"use client"

import { useInactivityLogout } from "@/hooks/use-inactivity-logout"

export function InactivityLogoutProvider() {
  useInactivityLogout()
  return null
}
