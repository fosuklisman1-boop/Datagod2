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
        /* Christmas Theme Colors */
        .christmas-theme {
          --christmas-red: #C41E3A;
          --christmas-green: #165B33;
          --christmas-gold: #FFD700;
          --christmas-white: #FFFFFF;
        }

        /* Background gradient */
        .christmas-theme body {
          background: linear-gradient(135deg, #0a3d1f 0%, #165B33 50%, #0d2618 100%);
          color: #333;
          position: relative;
          overflow-x: hidden;
        }

        /* Card styling with decorations */
        .christmas-theme .card,
        .christmas-theme [class*="card"] {
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(245, 250, 245, 0.98) 100%);
          border: 2px solid var(--christmas-red);
          box-shadow: 0 8px 16px rgba(196, 30, 58, 0.3), 0 0 20px rgba(22, 91, 51, 0.1);
          border-radius: 12px;
          position: relative;
          transition: all 0.3s ease;
          padding-top: 50px;
          overflow: visible;
        }

        .christmas-theme .card:hover,
        .christmas-theme [class*="card"]:hover {
          border-color: var(--christmas-green);
          box-shadow: 0 12px 24px rgba(22, 91, 51, 0.4), 0 0 25px rgba(196, 30, 58, 0.2);
          transform: translateY(-4px);
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

        /* Button styling */
        .christmas-theme button.bg-blue-600,
        .christmas-theme [class*="bg-cyan"],
        .christmas-theme .bg-violet-600,
        .christmas-theme button {
          background: linear-gradient(135deg, var(--christmas-red), #a01729) !important;
          color: white !important;
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
          box-shadow: 0 4px 15px rgba(196, 30, 58, 0.3);
          border-color: var(--christmas-red) !important;
        }

        .christmas-theme button.bg-blue-600:hover,
        .christmas-theme [class*="bg-cyan"]:hover,
        .christmas-theme .bg-violet-600:hover,
        .christmas-theme button:hover:not(:disabled) {
          background: linear-gradient(135deg, var(--christmas-green), #0d3b22) !important;
          box-shadow: 0 8px 20px rgba(22, 91, 51, 0.5);
          transform: translateY(-3px);
          border-color: var(--christmas-green) !important;
        }

        /* Badge styling */
        .christmas-theme .badge {
          background: linear-gradient(135deg, var(--christmas-red), #a01729) !important;
          color: white !important;
          box-shadow: 0 2px 8px rgba(196, 30, 58, 0.3);
        }

        /* Header styling */
        .christmas-theme h1,
        .christmas-theme h2,
        .christmas-theme h3,
        .christmas-theme h4,
        .christmas-theme h5,
        .christmas-theme h6 {
          color: var(--christmas-green);
          text-shadow: 2px 2px 4px rgba(255, 215, 0, 0.2);
          font-weight: 700;
        }

        /* Input styling */
        .christmas-theme input,
        .christmas-theme textarea,
        .christmas-theme select {
          border-color: var(--christmas-red) !important;
          background-color: rgba(255, 255, 255, 0.99) !important;
          transition: all 0.3s ease;
        }

        .christmas-theme input:focus,
        .christmas-theme textarea:focus,
        .christmas-theme select:focus {
          border-color: var(--christmas-green) !important;
          box-shadow: 0 0 0 4px rgba(22, 91, 51, 0.1), 0 0 0 2px var(--christmas-green) !important;
        }

        /* Link styling */
        .christmas-theme a {
          color: var(--christmas-red);
          text-decoration: underline;
          transition: all 0.3s ease;
          font-weight: 500;
        }

        .christmas-theme a:hover {
          color: var(--christmas-green);
          text-decoration: underline wavy;
        }

        /* Navigation/Sidebar styling */
        .christmas-theme [class*="sidebar"],
        .christmas-theme nav,
        .christmas-theme [class*="navbar"] {
          background: linear-gradient(180deg, var(--christmas-green) 0%, #0d3b22 100%);
          color: white;
          box-shadow: 0 4px 12px rgba(22, 91, 51, 0.3);
        }

        /* Table styling */
        .christmas-theme table th {
          background: linear-gradient(135deg, var(--christmas-red), #a01729);
          color: white;
          font-weight: 600;
        }

        .christmas-theme table tr:hover {
          background-color: rgba(196, 30, 58, 0.08);
        }

        /* Status badges */
        .christmas-theme .bg-green-100 {
          background-color: rgba(22, 91, 51, 0.2) !important;
          color: var(--christmas-green) !important;
          border: 1px solid rgba(22, 91, 51, 0.3);
        }

        .christmas-theme .bg-red-100 {
          background-color: rgba(196, 30, 58, 0.2) !important;
          color: var(--christmas-red) !important;
          border: 1px solid rgba(196, 30, 58, 0.3);
        }

        .christmas-theme .bg-yellow-100 {
          background-color: rgba(255, 215, 0, 0.2) !important;
          color: #b8860b !important;
          border: 1px solid rgba(255, 215, 0, 0.3);
        }

        .christmas-theme .bg-blue-100 {
          background-color: rgba(22, 91, 51, 0.15) !important;
          color: var(--christmas-green) !important;
          border: 1px solid rgba(22, 91, 51, 0.2);
        }

        /* Modal/Dialog styling */
        .christmas-theme [role="dialog"],
        .christmas-theme .modal {
          border: 3px solid var(--christmas-red);
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.99) 0%, rgba(245, 250, 245, 0.99) 100%);
          box-shadow: 0 20px 60px rgba(196, 30, 58, 0.4), 0 0 40px rgba(22, 91, 51, 0.2);
          border-radius: 12px;
        }

        /* Text colors */
        .christmas-theme .text-gray-600 {
          color: #2d5016 !important;
        }

        .christmas-theme .text-gray-900 {
          color: var(--christmas-green) !important;
        }

        /* Switch styling */
        .christmas-theme [role="switch"] {
          background-color: rgba(196, 30, 58, 0.2) !important;
        }

        .christmas-theme [role="switch"][aria-checked="true"] {
          background-color: var(--christmas-green) !important;
        }

        /* Alert styling */
        .christmas-theme .alert {
          border-left: 4px solid var(--christmas-red);
          background-color: rgba(196, 30, 58, 0.08);
          border-radius: 6px;
        }

        /* Disabled button state */
        .christmas-theme button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none !important;
        }

        /* Scrollbar styling */
        .christmas-theme ::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }

        .christmas-theme ::-webkit-scrollbar-track {
          background: rgba(22, 91, 51, 0.1);
        }

        .christmas-theme ::-webkit-scrollbar-thumb {
          background: var(--christmas-red);
          border-radius: 5px;
        }

        .christmas-theme ::-webkit-scrollbar-thumb:hover {
          background: var(--christmas-green);
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


