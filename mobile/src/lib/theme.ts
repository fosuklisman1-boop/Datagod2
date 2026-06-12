// "Modern Fintech" palette — mirrors the web app's design tokens in
// app/globals.css (:root, light). Keep in sync with the web reskin.
export const colors = {
  bg: "#f6f7f9",            // --background 220 20% 97%
  card: "#ffffff",          // --card
  border: "#e7eaee",        // --border 214 16% 92%
  text: "#0f172a",          // --foreground 222 47% 11%
  textMuted: "#64748b",     // --muted-foreground 215 16% 47%
  muted: "#f1f5f9",         // --muted 210 40% 96%
  primary: "#4f46e5",       // --primary 243 75% 59% (indigo)
  primaryDark: "#4338ca",   // indigo-700, pressed state
  primaryForeground: "#ffffff",
  violet: "#7c3aed",        // violet-600 — gradient partner on the web wallet hero
  success: "#16a34a",       // --success 142 71% 40%
  danger: "#dc2626",        // --destructive 0 72% 51%
  warning: "#d97706",       // --warning 35 92% 44%
}

// --radius is 0.9rem on the web (~14px); md/sm step down by 2px like tailwind config.
export const radius = { lg: 14, md: 12, sm: 10, full: 999 }

// Soft card shadow — the web's shadow-sm look, translated to RN.
export const cardShadow = {
  shadowColor: "#0f172a",
  shadowOpacity: 0.06,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 2,
}

// Network brand tokens (--mtn / --telecel / --at from globals.css).
export const networkColors: Record<string, string> = {
  MTN: "#ffcc00",
  Telecel: "#e3001b",
  AirtelTigo: "#0a5bd3",
  "AT-iShare": "#0a5bd3",
}
