"use client"

import { useChristmasTheme } from "@/hooks/use-christmas-theme"
import { useEffect } from "react"

export const ChristmasThemeProvider = () => {
  const { isChristmasEnabled } = useChristmasTheme()

  useEffect(() => {
    if (isChristmasEnabled) {
      // Inject Christmas theme CSS with animations
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

        /* Snowflake animation */
        @keyframes snowfall {
          0% {
            transform: translateY(-10vh) translateX(0px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) translateX(100px) rotate(360deg);
            opacity: 0;
          }
        }

        @keyframes snowfall-slow {
          0% {
            transform: translateY(-10vh) translateX(0px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) translateX(50px) rotate(360deg);
            opacity: 0;
          }
        }

        @keyframes snowfall-fast {
          0% {
            transform: translateY(-10vh) translateX(0px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) translateX(150px) rotate(360deg);
            opacity: 0;
          }
        }

        /* Snowflake creation */
        .christmas-theme::before {
          content: '❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆';
          position: fixed;
          top: -10vh;
          left: 0;
          width: 100%;
          font-size: 3rem;
          font-weight: bold;
          color: rgba(255, 255, 255, 0.8);
          white-space: nowrap;
          z-index: 1;
          pointer-events: none;
          display: block;
          animation: snowfall 15s linear infinite;
          text-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
        }

        .christmas-theme::after {
          content: '❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆ ❄ ❅ ❆';
          position: fixed;
          top: -5vh;
          left: 100px;
          width: 100%;
          font-size: 2.5rem;
          font-weight: bold;
          color: rgba(255, 255, 255, 0.6);
          white-space: nowrap;
          z-index: 0;
          pointer-events: none;
          display: block;
          animation: snowfall-slow 20s linear infinite;
          text-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
        }

        /* Background gradient */
        .christmas-theme body {
          background: linear-gradient(135deg, #0a3d1f 0%, #165B33 50%, #0d2618 100%);
          color: #333;
          position: relative;
          overflow-x: hidden;
        }

        /* Snow particle effect */
        .christmas-theme {
          position: relative;
        }

        .christmas-theme .snowflake {
          position: fixed;
          top: -10vh;
          color: white;
          font-size: 2rem;
          z-index: 1;
          text-shadow: 0 0 5px rgba(255, 255, 255, 0.8);
          pointer-events: none;
          opacity: 0.9;
        }

        /* Card styling for Christmas */
        .christmas-theme .card {
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(245, 250, 245, 0.98) 100%);
          border: 2px solid var(--christmas-red);
          box-shadow: 0 8px 16px rgba(196, 30, 58, 0.3), 0 0 20px rgba(22, 91, 51, 0.1);
          border-radius: 8px;
          position: relative;
          transition: all 0.3s ease;
        }

        .christmas-theme .card:hover {
          border-color: var(--christmas-green);
          box-shadow: 0 12px 24px rgba(22, 91, 51, 0.4), 0 0 25px rgba(196, 30, 58, 0.2);
          transform: translateY(-4px);
        }

        /* Christmas hat on cards */
        .christmas-theme .card::before {
          content: '🎅';
          position: absolute;
          top: -15px;
          right: 15px;
          font-size: 2.5rem;
          z-index: 10;
          animation: bounce 3s ease-in-out infinite;
          filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
        }

        /* Hanging bells decoration */
        .christmas-theme .card::after {
          content: '🔔 🔔';
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          font-size: 1.5rem;
          z-index: 10;
          animation: sway 4s ease-in-out infinite;
          filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
          opacity: 0.9;
        }

        /* Bounce animation for hat */
        @keyframes bounce {
          0%, 100% {
            transform: translateY(0px) rotate(0deg);
          }
          50% {
            transform: translateY(-10px) rotate(-5deg);
          }
        }

        /* Sway animation for bells */
        @keyframes sway {
          0%, 100% {
            transform: translateX(-50%) rotate(0deg);
          }
          25% {
            transform: translateX(-50%) rotate(-8deg);
          }
          75% {
            transform: translateX(-50%) rotate(8deg);
          }
        }

        /* Button styling */
        .christmas-theme button.bg-blue-600,
        .christmas-theme [class*="bg-cyan"],
        .christmas-theme .bg-violet-600 {
          background: linear-gradient(135deg, var(--christmas-red), #a01729) !important;
          color: white !important;
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
          box-shadow: 0 4px 15px rgba(196, 30, 58, 0.3);
        }

        .christmas-theme button.bg-blue-600:hover,
        .christmas-theme [class*="bg-cyan"]:hover,
        .christmas-theme .bg-violet-600:hover {
          background: linear-gradient(135deg, var(--christmas-green), #0d3b22) !important;
          box-shadow: 0 8px 20px rgba(22, 91, 51, 0.5);
          transform: translateY(-3px);
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

        /* Alert styling */
        .christmas-theme .alert {
          border-left: 4px solid var(--christmas-red);
          background-color: rgba(196, 30, 58, 0.08);
          border-radius: 6px;
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

        /* Button hover effect */
        .christmas-theme button {
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
          position: relative;
          overflow: hidden;
        }

        .christmas-theme button:hover:not(:disabled) {
          transform: translateY(-2px);
        }

        .christmas-theme button:active:not(:disabled) {
          transform: translateY(0px);
        }

        /* Disabled state */
        .christmas-theme button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        /* Switch styling */
        .christmas-theme [role="switch"] {
          background-color: rgba(196, 30, 58, 0.2) !important;
        }

        .christmas-theme [role="switch"][aria-checked="true"] {
          background-color: var(--christmas-green) !important;
        }

        /* Accent elements */
        .christmas-theme .accent-red {
          color: var(--christmas-red);
        }

        .christmas-theme .accent-green {
          color: var(--christmas-green);
        }

        .christmas-theme .accent-gold {
          color: var(--christmas-gold);
        }

        /* Smooth transitions */
        .christmas-theme * {
          transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
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
      }
    }
  }, [isChristmasEnabled])

  return null
}

export default ChristmasThemeProvider

