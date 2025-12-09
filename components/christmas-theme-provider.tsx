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

        /* Frost effect on page edges */
        .christmas-theme::before {
          content: "";
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: 
            radial-gradient(ellipse at 20% 10%, rgba(200, 220, 255, 0.15) 0%, transparent 30%),
            radial-gradient(ellipse at 80% 90%, rgba(180, 210, 255, 0.15) 0%, transparent 35%),
            radial-gradient(ellipse at 50% 50%, rgba(150, 200, 255, 0.08) 0%, transparent 50%);
          pointer-events: none;
          z-index: 0;
          animation: frost-pulse 8s ease-in-out infinite;
        }

        /* Card styling with ice effects */
        .christmas-theme .card,
        .christmas-theme [class*="card"] {
          position: relative;
          box-shadow: 
            inset 0 1px 3px rgba(200, 220, 255, 0.3),
            inset -1px -1px 3px rgba(150, 180, 255, 0.2);
        }

        /* Ice shimmer on card top */
        .christmas-theme .card::before,
        .christmas-theme [class*="card"]::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(200, 220, 255, 0.4), transparent);
          animation: ice-shimmer 3s ease-in-out infinite;
        }

        /* Ice line on card bottom */
        .christmas-theme .card::after,
        .christmas-theme [class*="card"]::after {
          content: "";
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(150, 200, 255, 0.3), transparent);
        }

        /* Button frost effect */
        .christmas-theme button {
          position: relative;
          overflow: hidden;
        }

        /* Frost shine animation on buttons */
        .christmas-theme button::before {
          content: "";
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
          animation: frost-shine 3s ease-in-out infinite;
          pointer-events: none;
        }

        /* Input frost overlay */
        .christmas-theme input,
        .christmas-theme textarea,
        .christmas-theme select {
          position: relative;
          box-shadow: inset 0 1px 2px rgba(200, 220, 255, 0.2);
        }

        /* Frost corner pattern - top left */
        body.christmas-theme::before {
          content: "";
          position: fixed;
          top: 0;
          left: 0;
          width: 100px;
          height: 100px;
          background: 
            repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(200, 220, 255, 0.1) 10px, rgba(200, 220, 255, 0.1) 20px),
            repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(180, 210, 255, 0.1) 10px, rgba(180, 210, 255, 0.1) 20px);
          pointer-events: none;
          z-index: 1;
          opacity: 0.5;
        }

        /* Frost corner pattern - bottom right */
        body.christmas-theme::after {
          content: "";
          position: fixed;
          bottom: 0;
          right: 0;
          width: 120px;
          height: 120px;
          background: 
            repeating-linear-gradient(45deg, transparent, transparent 15px, rgba(150, 200, 255, 0.08) 15px, rgba(150, 200, 255, 0.08) 30px),
            repeating-linear-gradient(-45deg, transparent, transparent 15px, rgba(200, 220, 255, 0.08) 15px, rgba(200, 220, 255, 0.08) 30px);
          pointer-events: none;
          z-index: 1;
          opacity: 0.6;
        }

        /* Frost animations */
        @keyframes frost-pulse {
          0%, 100% {
            opacity: 0.5;
          }
          50% {
            opacity: 0.8;
          }
        }

        @keyframes ice-shimmer {
          0%, 100% {
            opacity: 0.3;
            transform: translateX(-100%);
          }
          50% {
            opacity: 0.6;
          }
        }

        @keyframes frost-shine {
          0% {
            left: -100%;
          }
          100% {
            left: 100%;
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


