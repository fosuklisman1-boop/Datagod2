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
        const duration = 10 + Math.random() * 8
        const left = Math.random() * 100
        const size = 10 + Math.random() * 20

        snowflake.textContent = char
        snowflake.style.cssText = `
          position: absolute;
          top: -50px;
          left: ${left}%;
          font-size: ${size}px;
          color: rgba(255, 255, 255, ${0.7 + Math.random() * 0.3});
          text-shadow: 0 0 10px rgba(255, 255, 255, 0.8);
          animation: snowfall-${i} ${duration}s linear ${delay}s infinite;
          opacity: 0.9;
          font-weight: bold;
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

        /* Card styling with decorations */
        .christmas-theme .card,
        .christmas-theme [class*="card"] {
          position: relative;
          overflow: visible;
        }

        /* Santa Hat on Cards */
        .christmas-theme .card::before,
        .christmas-theme [class*="card"]::before {
          content: "🎅";
          position: absolute;
          top: -20px;
          right: 20px;
          font-size: 3rem;
          z-index: 20;
          animation: hat-bounce 2s ease-in-out infinite;
          filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.3));
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          display: block;
          line-height: 1;
        }

        /* Hanging Bells on Cards */
        .christmas-theme .card::after,
        .christmas-theme [class*="card"]::after {
          content: "🔔";
          position: absolute;
          top: -15px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 2.5rem;
          z-index: 20;
          animation: bell-sway 3s ease-in-out infinite;
          filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
          display: block;
          line-height: 1;
        }

        /* Hat bounce animation */
        @keyframes hat-bounce {
          0%, 100% {
            transform: translateY(0) rotate(0deg);
          }
          25% {
            transform: translateY(-15px) rotate(-5deg);
          }
          50% {
            transform: translateY(-25px) rotate(0deg);
          }
          75% {
            transform: translateY(-10px) rotate(5deg);
          }
        }

        /* Bell sway animation */
        @keyframes bell-sway {
          0%, 100% {
            transform: translateX(-50%) rotate(0deg);
          }
          25% {
            transform: translateX(-50%) rotate(-15deg);
          }
          50% {
            transform: translateX(-50%) rotate(0deg);
          }
          75% {
            transform: translateX(-50%) rotate(15deg);
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


