"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"

/**
 * Light/Dark toggle. Mounts after hydration to avoid a theme mismatch flash,
 * then swaps the icon based on the resolved theme.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const isDark = resolvedTheme === "dark"

  return (
    <Button
      variant="ghost"
      size="icon"
      className={className ?? "h-8 w-8 md:h-10 md:w-10"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {/* Render a stable icon until mounted to keep SSR/CSR markup identical */}
      {mounted && isDark ? (
        <Sun className="w-4 h-4 md:w-5 md:h-5" />
      ) : (
        <Moon className="w-4 h-4 md:w-5 md:h-5" />
      )}
    </Button>
  )
}
