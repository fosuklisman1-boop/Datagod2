import { Wrench } from "lucide-react"

// Full-screen maintenance takeover shown when MAINTENANCE_MODE=true.
//
// Intentionally self-contained and DB-free: it renders INSTEAD of the app
// providers (see app/layout.tsx), so no Supabase/auth calls fire while the
// backend is unavailable. Pure server-rendered markup — no client JS needed.
export function MaintenanceScreen() {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-card px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 shadow-lg">
          <Wrench className="h-10 w-10 text-white" />
        </div>

        <h1 className="mb-3 bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-3xl font-bold text-transparent sm:text-4xl">
          We&apos;ll be right back
        </h1>

        <p className="mb-2 text-base text-foreground">
          DATAGOD is undergoing scheduled maintenance.
        </p>
        <p className="mb-8 text-sm text-muted-foreground">
          We&apos;re working to get everything back up and running. Please check
          back again in a little while — thank you for your patience.
        </p>

        <div className="rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground">
          Need urgent help? Reach us at{" "}
          <a
            href="mailto:support@datagod.com"
            className="font-semibold text-violet-600 hover:text-violet-700"
          >
            support@datagod.com
          </a>
        </div>
      </div>
    </div>
  )
}
