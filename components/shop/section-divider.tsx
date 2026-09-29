"use client"

// Real, rendering SVG dividers for a shop's storefront hero. Each style id here
// is exactly the set validated server-side in app/api/shop/manage/route.ts's
// DIVIDER_STYLES whitelist — keep the two in sync.

export interface DividerOption {
  id: string
  label: string
}

export const DIVIDER_STYLE_OPTIONS: DividerOption[] = [
  { id: "asymmetrical-curve", label: "Asymmetrical Curve" },
  { id: "angled-divider", label: "Angled Divider" },
  { id: "geometric-zigzag", label: "Geometric Zig-Zag" },
  { id: "concave-curve", label: "Concave Curve" },
  { id: "animated-wave", label: "Animated Wave" },
  { id: "layered-waves", label: "Layered Waves" },
  { id: "tilt-divider", label: "Tilt Divider" },
  { id: "organic-blob", label: "Organic Blob" },
  { id: "paper-cut", label: "Paper Cut" },
  { id: "torn-edge", label: "Torn Edge" },
  { id: "convex-curve", label: "Convex Curve" },
  { id: "slant-transition", label: "Slant Transition" },
  { id: "skewed-transition", label: "Skewed Transition" },
  { id: "glassmorphic-glow", label: "Glassmorphic Glow" },
  { id: "multi-step-wave", label: "Multi-Step Wave" },
]

const W = 1200
const H = 120

function wavePath(amplitude: number, cycles: number, phase = 0, baseline = H * 0.5): string {
  const step = W / (cycles * 2)
  let d = `M0,${baseline}`
  for (let i = 0; i < cycles * 2; i++) {
    const x1 = i * step + step / 2
    const x2 = (i + 1) * step
    const dir = (i + phase) % 2 === 0 ? -1 : 1
    const y = baseline + dir * amplitude
    d += ` Q${x1},${y} ${x2},${baseline}`
  }
  d += ` L${W},${H} L0,${H} Z`
  return d
}

function zigzagPath(teeth: number, peakY: number, baseY: number, irregular = false): string {
  const step = W / teeth
  let d = `M0,${baseY}`
  for (let i = 0; i <= teeth; i++) {
    const x = i * step
    const jitter = irregular ? ((i * 37) % 17) - 8 : 0
    const y = i % 2 === 0 ? peakY + jitter : baseY + jitter
    d += ` L${x},${y}`
  }
  d += ` L${W},${H} L0,${H} Z`
  return d
}

function stepPath(steps: number): string {
  const stepW = W / steps
  const stepH = H * 0.35
  let d = `M0,${H * 0.7}`
  for (let i = 0; i < steps; i++) {
    const x = i * stepW
    const up = i % 2 === 0
    const y = up ? H * 0.7 - stepH : H * 0.7
    d += ` L${x},${y} L${x + stepW},${y}`
  }
  d += ` L${W},${H} L0,${H} Z`
  return d
}

function pathFor(style: string): string {
  switch (style) {
    case "asymmetrical-curve":
      return `M0,${H * 0.4} Q${W * 0.3},${H * 0.9} ${W * 0.65},${H * 0.5} T${W},${H * 0.35} L${W},${H} L0,${H} Z`
    case "angled-divider":
      return `M0,${H * 0.15} L${W},${H * 0.85} L${W},${H} L0,${H} Z`
    case "tilt-divider":
      return `M0,${H * 0.85} L${W},${H * 0.15} L${W},${H} L0,${H} Z`
    case "slant-transition":
      return `M0,0 L${W},${H} L0,${H} Z`
    case "skewed-transition":
      return `M0,${H} L0,${H * 0.2} Q${W * 0.5},0 ${W},${H * 0.4} L${W},${H} Z`
    case "geometric-zigzag":
      return zigzagPath(14, H * 0.25, H * 0.65)
    case "paper-cut":
      return zigzagPath(9, H * 0.15, H * 0.55, true)
    case "torn-edge":
      return zigzagPath(22, H * 0.3, H * 0.6, true)
    case "concave-curve":
      return `M0,${H * 0.3} Q${W / 2},${H} ${W},${H * 0.3} L${W},${H} L0,${H} Z`
    case "convex-curve":
      return `M0,${H * 0.7} Q${W / 2},0 ${W},${H * 0.7} L${W},${H} L0,${H} Z`
    case "organic-blob":
      return `M0,${H * 0.5} Q${W * 0.15},${H * 0.2} ${W * 0.35},${H * 0.55} T${W * 0.7},${H * 0.4} Q${W * 0.85},${H * 0.25} ${W},${H * 0.6} L${W},${H} L0,${H} Z`
    case "layered-waves":
      return wavePath(14, 3, 0)
    case "multi-step-wave":
      return stepPath(10)
    case "animated-wave":
    default:
      return wavePath(18, 4, 0)
  }
}

interface SectionDividerProps {
  style?: string | null
  color: string
  className?: string
}

// Rendered at the bottom of a colored hero: fills up to the wavy/angled line in
// `color`, page background shows through below it. "glassmorphic-glow" has no
// real shape to cut (a blur has no crisp edge) so it renders a soft fading
// gradient instead of an SVG path.
export function SectionDivider({ style, color, className = "" }: SectionDividerProps) {
  if (!style) return null

  if (style === "glassmorphic-glow") {
    return (
      <div
        className={`h-16 w-full ${className}`}
        style={{ background: `linear-gradient(to bottom, ${color}66, ${color}00)`, backdropFilter: "blur(8px)" }}
        aria-hidden="true"
      />
    )
  }

  const isAnimated = style === "animated-wave"
  return (
    <div className={`relative h-16 w-full overflow-hidden ${className}`} aria-hidden="true">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={`absolute inset-0 h-full w-full ${isAnimated ? "shop-divider-animate" : ""}`}
      >
        <path d={pathFor(style)} fill={color} />
      </svg>
      {isAnimated && (
        <style jsx>{`
          .shop-divider-animate {
            animation: shop-divider-drift 8s ease-in-out infinite;
          }
          @keyframes shop-divider-drift {
            0%, 100% { transform: translateX(0); }
            50% { transform: translateX(-2%); }
          }
        `}</style>
      )}
    </div>
  )
}
