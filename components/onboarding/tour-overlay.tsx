"use client"

import { useEffect, useRef } from "react"

interface TourOverlayProps {
  spotlight: {
    position: {
      top: number
      left: number
      width: number
      height: number
    }
  } | null
  message: string
  direction?: "top" | "bottom" | "left" | "right"
  onElementClick?: () => void
}

export function TourOverlay({ spotlight, message, direction = "bottom", onElementClick }: TourOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!spotlight || !canvasRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Set canvas size to window size
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight

    // Draw semi-transparent overlay
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)"
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Clear the spotlight area
    const padding = 8
    ctx.clearRect(
      spotlight.position.left - padding,
      spotlight.position.top - padding,
      spotlight.position.width + padding * 2,
      spotlight.position.height + padding * 2
    )

    // Draw highlight border
    ctx.strokeStyle = "rgba(59, 130, 246, 1)"
    ctx.lineWidth = 3
    ctx.setLineDash([5, 5])
    ctx.strokeRect(
      spotlight.position.left - padding,
      spotlight.position.top - padding,
      spotlight.position.width + padding * 2,
      spotlight.position.height + padding * 2
    )
    ctx.setLineDash([])

    // Draw pulsing glow
    ctx.shadowColor = "rgba(59, 130, 246, 0.5)"
    ctx.shadowBlur = 20
    ctx.strokeStyle = "rgba(59, 130, 246, 0.3)"
    ctx.lineWidth = 2
    ctx.strokeRect(
      spotlight.position.left - padding - 10,
      spotlight.position.top - padding - 10,
      spotlight.position.width + padding * 2 + 20,
      spotlight.position.height + padding * 2 + 20
    )
  }, [spotlight])

  if (!spotlight) return null

  // Calculate tooltip position
  const padding = 16
  let tooltipTop = spotlight.position.top
  let tooltipLeft = spotlight.position.left
  let arrowClass = ""

  switch (direction) {
    case "top":
      tooltipTop = spotlight.position.top - padding - 80
      tooltipLeft = spotlight.position.left + spotlight.position.width / 2
      arrowClass = "bottom"
      break
    case "bottom":
      tooltipTop = spotlight.position.top + spotlight.position.height + padding
      tooltipLeft = spotlight.position.left + spotlight.position.width / 2
      arrowClass = "top"
      break
    case "left":
      tooltipTop = spotlight.position.top + spotlight.position.height / 2
      tooltipLeft = spotlight.position.left - padding - 300
      arrowClass = "right"
      break
    case "right":
      tooltipTop = spotlight.position.top + spotlight.position.height / 2
      tooltipLeft = spotlight.position.left + spotlight.position.width + padding
      arrowClass = "left"
      break
  }

  return (
    <div className="fixed inset-0 pointer-events-none z-[1001]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-auto"
        onClick={onElementClick}
      />

      {/* Tooltip */}
      <div
        className="absolute bg-white rounded-lg shadow-2xl border border-blue-500 p-4 max-w-xs z-[1002] pointer-events-auto transform -translate-x-1/2"
        style={{
          top: `${tooltipTop}px`,
          left: `${tooltipLeft}px`,
        }}
      >
        <div className="flex gap-3">
          <div className="text-2xl flex-shrink-0">👆</div>
          <div>
            <p className="text-sm font-medium text-gray-900 leading-relaxed">
              {message}
            </p>
          </div>
        </div>

        {/* Animated pulse dot */}
        <div className="absolute top-1 right-1">
          <div className="relative w-3 h-3">
            <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping"></div>
            <div className="absolute inset-0 bg-blue-500 rounded-full"></div>
          </div>
        </div>
      </div>
    </div>
  )
}
