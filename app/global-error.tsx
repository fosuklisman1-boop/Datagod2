"use client"
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#030303", color: "#FAFAFA", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "24px" }}>
        <div style={{ maxWidth: 420 }}>
          <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#34D399" }}>Fatal error</p>
          <h1 style={{ marginTop: 12, fontSize: 28, fontWeight: 600 }}>The app crashed</h1>
          <p style={{ marginTop: 8, fontSize: 14, color: "#A1A1AA" }}>A critical error occurred. Reload to continue.</p>
          <button onClick={reset} style={{ marginTop: 24, background: "#34D399", color: "#04120c", border: 0, borderRadius: 8, padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>Reload</button>
        </div>
      </body>
    </html>
  )
}
