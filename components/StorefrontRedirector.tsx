"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

export default function StorefrontRedirector() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isChecking, setIsChecking] = useState(true)

  useEffect(() => {
    // Check if user is explicitly trying to clear their storefront association
    const clearStorefront = searchParams.get("clear_storefront")

    if (clearStorefront === "true") {
      localStorage.removeItem("storefront_slug")
      setIsChecking(false)
      return
    }

    // Check if user belongs to a storefront
    const storefrontSlug = localStorage.getItem("storefront_slug")

    if (storefrontSlug) {
      // User is associated with a storefront, redirect them back
      router.replace(`/shop/${storefrontSlug}`)
    } else {
      // User is not associated with a storefront, allow them to stay
      setIsChecking(false)
    }
  }, [router, searchParams])

  // Optional: You could return a full-page loading state here if you want to completely 
  // hide the main page before the redirect happens. Returning null is less intrusive 
  // but might cause a brief flash of the main content before redirecting.
  // We'll return a full black screen to ensure the user never sees the main site 
  // while we are checking their local storage.
  if (isChecking) {
    return (
      <div className="fixed inset-0 bg-white z-[100] flex items-center justify-center">
        <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full border-4 border-violet-600 border-t-transparent animate-spin mb-4"></div>
            <p className="text-gray-600">Redirecting to your store...</p>
        </div>
      </div>
    )
  }

  return null
}
