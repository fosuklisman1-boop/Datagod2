"use client"

import { useChristmasTheme } from "@/hooks/use-christmas-theme"
import { useEffect } from "react"

export const ChristmasThemeProvider = () => {
  const { isChristmasEnabled } = useChristmasTheme()

  useEffect(() => {
    if (isChristmasEnabled) {
      // Inject Christmas theme CSS
      const style = document.createElement("style")
      style.id = "christmas-theme-styles"
      style.textContent = `
        /* Christmas Theme Styles */
        .christmas-theme {
          --christmas-red: #C41E3A;
          --christmas-green: #165B33;
          --christmas-gold: #FFD700;
          --christmas-white: #FFFFFF;
        }

        /* Background with subtle snow pattern */
        .christmas-theme body {
          background: linear-gradient(135deg, #165B33 0%, #1a7a4d 50%, #0d3b22 100%);
          color: #333;
          position: relative;
        }

        /* Animated snowfall */
        .christmas-theme::before {
          content: '';
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          background-image: 
            radial-gradient(2px 2px at 20px 30px, white, rgba(255, 255, 255, 0.5)),
            radial-gradient(2px 2px at 60px 70px, white, rgba(255, 255, 255, 0.5)),
            radial-gradient(1px 1px at 50px 50px, white, rgba(255, 255, 255, 0.5)),
            radial-gradient(1px 1px at 130px 80px, white, rgba(255, 255, 255, 0.5)),
            radial-gradient(2px 2px at 90px 10px, white, rgba(255, 255, 255, 0.5));
          background-repeat: repeat;
          background-size: 200px 200px;
          animation: snowfall 20s linear infinite;
          z-index: -1;
        }

        @keyframes snowfall {
          0% {
            transform: translateY(-200px);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh);
            opacity: 0;
          }
        }

        /* Card styling for Christmas */
        .christmas-theme .card {
          background-color: rgba(255, 255, 255, 0.95);
          border: 2px solid var(--christmas-red);
          box-shadow: 0 4px 6px rgba(196, 30, 58, 0.2);
          border-radius: 8px;
        }

        .christmas-theme .card:hover {
          border-color: var(--christmas-green);
          box-shadow: 0 8px 12px rgba(22, 91, 51, 0.3);
        }

        /* Button styling */
        .christmas-theme button.bg-blue-600,
        .christmas-theme [class*="bg-cyan"] {
          background-color: var(--christmas-red) !important;
          transition: all 0.3s ease;
        }

        .christmas-theme button.bg-blue-600:hover,
        .christmas-theme [class*="bg-cyan"]:hover {
          background-color: var(--christmas-green) !important;
          box-shadow: 0 4px 12px rgba(22, 91, 51, 0.4);
        }

        /* Badge styling */
        .christmas-theme .badge {
          background-color: var(--christmas-red) !important;
          color: white !important;
        }

        /* Header styling */
        .christmas-theme h1,
        .christmas-theme h2,
        .christmas-theme h3 {
          color: var(--christmas-green);
          text-shadow: 1px 1px 2px rgba(255, 215, 0, 0.3);
        }

        /* Input styling */
        .christmas-theme input,
        .christmas-theme textarea,
        .christmas-theme select {
          border-color: var(--christmas-red) !important;
          background-color: rgba(255, 255, 255, 0.98) !important;
        }

        .christmas-theme input:focus,
        .christmas-theme textarea:focus,
        .christmas-theme select:focus {
          border-color: var(--christmas-green) !important;
          box-shadow: 0 0 0 3px rgba(196, 30, 58, 0.1) !important;
        }

        /* Decoration elements */
        .christmas-theme::after {
          content: '🎄 🎅 ⛄ 🎁 ❄️ 🎄 🎅 ⛄ 🎁 ❄️ 🎄 🎅 ⛄ 🎁 ❄️';
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          text-align: center;
          font-size: 24px;
          padding: 10px;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
          letter-spacing: 10px;
          z-index: 0;
          pointer-events: none;
        }

        /* Link styling */
        .christmas-theme a {
          color: var(--christmas-red);
          text-decoration: underline;
          transition: color 0.3s ease;
        }

        .christmas-theme a:hover {
          color: var(--christmas-green);
        }

        /* Sidebar/Navigation styling */
        .christmas-theme [class*="sidebar"],
        .christmas-theme nav {
          background: linear-gradient(180deg, var(--christmas-green), #0d3b22);
          color: white;
        }

        /* Table styling */
        .christmas-theme table th {
          background-color: var(--christmas-red);
          color: white;
        }

        .christmas-theme table tr:hover {
          background-color: rgba(196, 30, 58, 0.1);
        }

        /* Alert styling */
        .christmas-theme .alert {
          border-color: var(--christmas-red);
          background-color: rgba(196, 30, 58, 0.1);
        }

        /* Status badges */
        .christmas-theme .bg-green-100 {
          background-color: rgba(22, 91, 51, 0.2) !important;
          color: var(--christmas-green) !important;
        }

        .christmas-theme .bg-red-100 {
          background-color: rgba(196, 30, 58, 0.2) !important;
          color: var(--christmas-red) !important;
        }

        .christmas-theme .bg-yellow-100 {
          background-color: rgba(255, 215, 0, 0.2) !important;
          color: #b8860b !important;
        }

        .christmas-theme .bg-blue-100 {
          background-color: rgba(22, 91, 51, 0.15) !important;
          color: var(--christmas-green) !important;
        }

        /* Modal/Dialog styling */
        .christmas-theme [role="dialog"],
        .christmas-theme .modal {
          border: 3px solid var(--christmas-red);
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(255, 250, 240, 0.98) 100%);
          box-shadow: 0 10px 40px rgba(196, 30, 58, 0.3);
        }

        /* Text styling */
        .christmas-theme .text-gray-600 {
          color: #2d5016 !important;
        }

        .christmas-theme .text-gray-900 {
          color: var(--christmas-green) !important;
        }

        /* Special animation for buttons on hover */
        .christmas-theme button {
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .christmas-theme button:hover {
          transform: translateY(-2px);
        }

        /* Snowflake decoration in corners */
        @keyframes rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .christmas-theme .fixed {
          position: relative;
        }
      `
      document.head.appendChild(style)

      return () => {
        const existingStyle = document.getElementById("christmas-theme-styles")
        if (existingStyle) {
          existingStyle.remove()
        }
      }
    }
  }, [isChristmasEnabled])

  return null
}

export default ChristmasThemeProvider
