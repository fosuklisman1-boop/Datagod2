// lib/network-theme.ts

export interface NetworkTheme {
  hex: string          // brand color
  soft: string         // light tint for backgrounds/badges
  text: string         // text color to use on `hex`
  ring: string         // tailwind arbitrary-value ring class
}

// Brand colors. MTN/Telecel match mobile/src/lib/theme.ts networkColors so the
// two surfaces stay visually consistent. AT-BigTime is a best-guess teal —
// adjust if there's an official brand color.
export const NETWORK_THEMES: Record<string, NetworkTheme> = {
  MTN: {
    hex: "#ffcc00",
    soft: "#fff7d6",
    text: "#1a1a1a",
    ring: "ring-[#ffcc00]",
  },
  Telecel: {
    hex: "#e3001b",
    soft: "#fde8ea",
    text: "#ffffff",
    ring: "ring-[#e3001b]",
  },
  "AT - iShare": {
    hex: "#0a5bd3",
    soft: "#e6edfb",
    text: "#ffffff",
    ring: "ring-[#0a5bd3]",
  },
  "AT - BigTime": {
    hex: "#0d9488",
    soft: "#e3f5f3",
    text: "#ffffff",
    ring: "ring-[#0d9488]",
  },
}

// Fallback for any network not in the map above (keeps old cyan/violet look).
export const DEFAULT_THEME: NetworkTheme = {
  hex: "#0891b2",
  soft: "#e0f7fb",
  text: "#ffffff",
  ring: "ring-cyan-500",
}

export function getNetworkTheme(network: string): NetworkTheme {
  return NETWORK_THEMES[network] ?? DEFAULT_THEME
}

// "AT - iShare" -> "AT iShare" for display labels (DB values keep the " - ").
export function formatNetworkLabel(network: string): string {
  return network.replace(/\s*-\s*/g, " ")
}

// Canonical display order — selector cards and sort order both use this.
// Must match the exact `packages.network` values stored in the DB.
export const NETWORK_ORDER = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]
