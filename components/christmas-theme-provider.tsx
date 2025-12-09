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
        const duration = 3 + Math.random() * 2
        const left = Math.random() * 100
        const size = 15 + Math.random() * 20

        snowflake.textContent = char
        snowflake.style.cssText = `
          position: absolute;
          top: -50px;
          left: ${left}%;
          font-size: ${size}px;
          color: rgba(120, 190, 255, 0.6);
          text-shadow: none;
          animation: snowfall-${i} ${duration}s linear ${delay}s infinite;
          opacity: 0.6;
          font-weight: bold;
          filter: none;
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
              transform: translateY(120vh) translateX(${drift}px) rotate(360deg);
              opacity: 1;
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
        /* Christmas Theme - Snowfall with Freezing Effects */
        .christmas-theme {
          position: relative;
        }

        /* Frost overlay background */
        .christmas-theme body {
          position: relative;
        }

        /* Frost effect on entire page */
        .christmas-theme {
          background: 
            radial-gradient(ellipse at 20% 10%, rgba(200, 220, 255, 0.12) 0%, transparent 30%),
            radial-gradient(ellipse at 80% 90%, rgba(180, 210, 255, 0.12) 0%, transparent 35%),
            radial-gradient(ellipse at 50% 50%, rgba(150, 200, 255, 0.06) 0%, transparent 50%);
          animation: frost-pulse 8s ease-in-out infinite;
        }

        /* Card styling with ice effects */
        .christmas-theme .card,
        .christmas-theme [class*="card"] {
          position: relative;
          border-top: 1px solid rgba(200, 220, 255, 0.4);
          border-bottom: 1px solid rgba(150, 200, 255, 0.2);
          box-shadow: 
            inset 0 1px 3px rgba(200, 220, 255, 0.2),
            0 4px 6px rgba(0, 0, 0, 0.05);
          animation: ice-shimmer 3s ease-in-out infinite;
        }

        /* Input frost overlay */
        .christmas-theme input,
        .christmas-theme textarea,
        .christmas-theme select {
          position: relative;
          box-shadow: inset 0 1px 2px rgba(200, 220, 255, 0.15);
          border-color: rgba(200, 220, 255, 0.3);
        }

        .christmas-theme input:focus,
        .christmas-theme textarea:focus,
        .christmas-theme select:focus {
          border-color: rgba(200, 220, 255, 0.5);
          box-shadow: inset 0 1px 2px rgba(200, 220, 255, 0.15), 0 0 0 3px rgba(200, 220, 255, 0.1);
        }

        /* Button frost glow */
        .christmas-theme button {
          position: relative;
          overflow: visible;
          box-shadow: 0 2px 8px rgba(200, 220, 255, 0.2);
        }

        .christmas-theme button:hover {
          box-shadow: 0 4px 12px rgba(200, 220, 255, 0.3);
        }

        /* Frost corner pattern - top left */
        .christmas-theme::before {
          content: "";
          position: fixed;
          top: 0;
          left: 0;
          width: 150px;
          height: 150px;
          background: 
            repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(200, 220, 255, 0.08) 10px, rgba(200, 220, 255, 0.08) 20px),
            repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(180, 210, 255, 0.08) 10px, rgba(180, 210, 255, 0.08) 20px);
          pointer-events: none;
          z-index: 2;
          opacity: 0.7;
        }

        /* Frost corner pattern - bottom right */
        .christmas-theme::after {
          content: "";
          position: fixed;
          bottom: 0;
          right: 0;
          width: 180px;
          height: 180px;
          background: 
            repeating-linear-gradient(45deg, transparent, transparent 15px, rgba(150, 200, 255, 0.08) 15px, rgba(150, 200, 255, 0.08) 30px),
            repeating-linear-gradient(-45deg, transparent, transparent 15px, rgba(200, 220, 255, 0.08) 15px, rgba(200, 220, 255, 0.08) 30px);
          pointer-events: none;
          z-index: 2;
          opacity: 0.8;
        }

        /* Frost animations */
        @keyframes frost-pulse {
          0%, 100% {
            background: 
              radial-gradient(ellipse at 20% 10%, rgba(200, 220, 255, 0.12) 0%, transparent 30%),
              radial-gradient(ellipse at 80% 90%, rgba(180, 210, 255, 0.12) 0%, transparent 35%),
              radial-gradient(ellipse at 50% 50%, rgba(150, 200, 255, 0.06) 0%, transparent 50%);
          }
          50% {
            background: 
              radial-gradient(ellipse at 20% 10%, rgba(200, 220, 255, 0.18) 0%, transparent 30%),
              radial-gradient(ellipse at 80% 90%, rgba(180, 210, 255, 0.18) 0%, transparent 35%),
              radial-gradient(ellipse at 50% 50%, rgba(150, 200, 255, 0.1) 0%, transparent 50%);
          }
        }

        @keyframes ice-shimmer {
          0%, 100% {
            border-top-color: rgba(200, 220, 255, 0.2);
            border-bottom-color: rgba(150, 200, 255, 0.1);
          }
          50% {
            border-top-color: rgba(200, 220, 255, 0.6);
            border-bottom-color: rgba(150, 200, 255, 0.3);
          }
        }

        /* Hat bounce animation */
        @keyframes hat-bounce {
          0%, 100% {
            transform: rotate(0deg) translateY(0);
          }
          50% {
            transform: rotate(-8deg) translateY(-2px);
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


