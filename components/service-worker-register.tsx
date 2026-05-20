"use client"

import { useEffect } from "react"

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing
          if (!worker) return

          worker.addEventListener("statechange", () => {
            if (worker.state !== "installed" || !navigator.serviceWorker.controller) return

            // Show update banner via vanilla DOM — no React/JSX needed
            const banner = document.createElement("div")
            banner.id = "sw-update-banner"
            Object.assign(banner.style, {
              position: "fixed",
              bottom: "20px",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: "9999",
              background: "#1e1b4b",
              border: "1px solid #4f46e5",
              borderRadius: "12px",
              padding: "12px 20px",
              display: "flex",
              alignItems: "center",
              gap: "16px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              color: "#e2e8f0",
              fontSize: "14px",
              whiteSpace: "nowrap",
            })

            const msg = document.createElement("span")
            msg.textContent = "🔄 A new version of DATAGOD is ready."

            const refreshBtn = document.createElement("button")
            refreshBtn.textContent = "Refresh"
            Object.assign(refreshBtn.style, {
              background: "#4f46e5",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "6px 16px",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
            })
            refreshBtn.onclick = () => {
              worker.postMessage({ type: "SKIP_WAITING" })
              window.location.reload()
            }

            const dismissBtn = document.createElement("button")
            dismissBtn.textContent = "✕"
            dismissBtn.setAttribute("aria-label", "Dismiss")
            Object.assign(dismissBtn.style, {
              background: "transparent",
              color: "#94a3b8",
              border: "none",
              cursor: "pointer",
              fontSize: "16px",
              padding: "0",
            })
            dismissBtn.onclick = () => banner.remove()

            banner.appendChild(msg)
            banner.appendChild(refreshBtn)
            banner.appendChild(dismissBtn)
            document.body.appendChild(banner)
          })
        })
      })
      .catch((err) => console.error("[SW] Registration failed:", err))
  }, [])

  return null
}
