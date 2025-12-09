"use client"

import { useChristmasTheme } from "@/hooks/use-christmas-theme"
import { useEffect } from "react"

export const ChristmasThemeProvider = () => {
  const { isChristmasEnabled } = useChristmasTheme()

  useEffect(() => {
    if (isChristmasEnabled) {
      // Create snowflake container
      const snowContainer = document.createElement("div")
      snowContainer.id = "christmas-snowflakes"
      snowContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1;
        overflow: hidden;
      `

      // Create multiple snowflakes
      const snowflakeChars = ["❄", "❅", "❆", "✶", "✸"]
      const totalSnowflakes = 50

      for (let i = 0; i < totalSnowflakes; i++) {
        const snowflake = document.createElement("div")
        const char = snowflakeChars[Math.floor(Math.random() * snowflakeChars.length)]
        const delay = Math.random() * 5
        const duration = 5 + Math.random() * 4
        const left = Math.random() * 100
        const size = 15 + Math.random() * 20

        snowflake.textContent = char
        snowflake.style.cssText = `
          position: absolute;
          top: -50px;
          left: ${left}%;
          font-size: ${size}px;
          color: rgba(255, 255, 255, 1);
          text-shadow: 0 0 20px rgba(255, 255, 255, 1), 0 0 40px rgba(100, 200, 255, 1);
          animation: snowfall-${i} ${duration}s linear ${delay}s infinite;
          opacity: 1;
          font-weight: bold;
          filter: drop-shadow(0 0 5px rgba(255, 255, 255, 1));
        `

        snowContainer.appendChild(snowflake)

        // Create unique animation for each snowflake
        const style = document.createElement("style")
        const drift = (Math.random() - 0.5) * 100
        style.textContent = `
          @keyframes snowfall-${i} {
            0% {
              transform: translateY(-50px) translateX(0) rotate(0deg);
              opacity: 1;
            }
            100% {
              transform: translateY(100vh) translateX(${drift}px) rotate(360deg);
              opacity: 0;
            }
          }
        `
        document.head.appendChild(style)
      }

      document.body.appendChild(snowContainer)

      // Inject Christmas theme CSS
      const style = document.createElement("style")
      style.id = "christmas-theme-styles"
      style.textContent = `
        /* Christmas Theme - Decorations Only */
        .christmas-theme {
          position: relative;
        }

        /* Card styling */
        .christmas-theme .card,
        .christmas-theme [class*="card"] {
          position: relative;
        }

        /* Santa hat on prices and wallet balances */
        .christmas-theme [class*="price"]::before,
        .christmas-theme [class*="balance"]::before,
        .christmas-theme [class*="wallet"]::before {
          content: "🎅";
          margin-right: 4px;
          font-size: 1.2em;
          display: inline-block;
          animation: hat-wiggle 2s ease-in-out infinite;
        }

        /* Hat wiggle animation */
        @keyframes hat-wiggle {
          0%, 100% {
            transform: rotate(0deg) scale(1);
          }
          50% {
            transform: rotate(-5deg) scale(1.05);
          }
        }
      `
      document.head.appendChild(style)

      return () => {
        const existingStyle = document.getElementById("christmas-theme-styles")
        if (existingStyle) {
          existingStyle.remove()
        }
        const existingSnow = document.getElementById("christmas-snowflakes")
        if (existingSnow) {
          existingSnow.remove()
        }
      }
    }
  }, [isChristmasEnabled])

  return null
}

export default ChristmasThemeProvider


