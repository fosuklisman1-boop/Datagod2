"use client"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { NETWORK_ORDER, formatNetworkLabel, getNetworkTheme } from "@/lib/network-theme"

interface NetworkSelectorProps {
  networks?: string[]              // defaults to NETWORK_ORDER
  selected: string
  onSelect: (network: string) => void
  logos: Record<string, string>
  /** network -> true if at least one package for it is available */
  liveStatus: Record<string, boolean>
}

export function NetworkSelector({
  networks = NETWORK_ORDER,
  selected,
  onSelect,
  logos,
  liveStatus,
}: NetworkSelectorProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
      {networks.map((network) => {
        const theme = getNetworkTheme(network)
        const isSelected = selected === network
        const isLive = liveStatus[network] ?? false
        const logo = logos[network] || logos[network.replace(/-/g, "")] || ""

        return (
          <Card
            key={network}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(network)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(network)}
            className={cn(
              "relative flex flex-col items-center gap-2 p-3 sm:p-4 cursor-pointer transition-all border-2",
              isSelected
                ? cn("border-transparent ring-2", theme.ring)
                : "border-border hover:border-muted-foreground/30"
            )}
          >
            {isSelected && (
              <span
                className="absolute top-2 right-2 w-4 h-4 rounded-full grid place-items-center text-white text-[10px]"
                style={{ backgroundColor: theme.hex, color: theme.text }}
              >
                ✓
              </span>
            )}
            <div className="h-10 w-10 sm:h-12 sm:w-12 grid place-items-center">
              {logo ? (
                <img src={logo} alt={network} className="h-full w-full object-contain" />
              ) : (
                <div
                  className="h-full w-full rounded-full"
                  style={{ backgroundColor: theme.hex }}
                />
              )}
            </div>
            <span className="text-xs sm:text-sm font-semibold text-foreground text-center">
              {formatNetworkLabel(network)}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-full",
                isLive
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", isLive ? "bg-emerald-500" : "bg-red-500")} />
              {isLive ? "Live" : "Out of Stock"}
            </span>
          </Card>
        )
      })}
    </div>
  )
}
