"use client"

import { createContext, useContext, type ReactNode } from "react"
import { hexToHslTriplet, type DomainService } from "@/lib/custom-domains"

export interface DomainBranding {
  service: DomainService | null
  siteName: string | null
  logoUrl: string | null
  primaryColor: string | null
}

const DEFAULT_BRANDING: DomainBranding = {
  service: null,
  siteName: null,
  logoUrl: null,
  primaryColor: null,
}

const DomainBrandingContext = createContext<DomainBranding>(DEFAULT_BRANDING)

/** Returns the current request's custom-domain branding, or the default
 * (all-null, `service: null` meaning "no restriction") on the main site/shop. */
export function useDomainBranding(): DomainBranding {
  return useContext(DomainBrandingContext)
}

export function DomainBrandingProvider({
  branding,
  children,
}: {
  branding: DomainBranding
  children: ReactNode
}) {
  const hsl = branding.primaryColor ? hexToHslTriplet(branding.primaryColor) : null

  return (
    <DomainBrandingContext.Provider value={branding}>
      {hsl && <style>{`:root { --primary: ${hsl}; }`}</style>}
      {children}
    </DomainBrandingContext.Provider>
  )
}
