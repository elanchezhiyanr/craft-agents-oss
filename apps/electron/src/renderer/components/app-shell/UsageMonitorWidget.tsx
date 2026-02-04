import * as React from "react"

import { cn } from "@/lib/utils"
import type { UsageMonitorConfigPayload, UsageMonitorSnapshot } from "../../../shared/types"

interface UsageMonitorWidgetProps {
  className?: string
}

function formatTimeRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours} hr ${minutes} min`
}

function getUsageColor(percent: number): { bar: string; text: string } {
  if (percent >= 100) return { bar: "bg-destructive", text: "text-destructive" }
  if (percent > 90) return { bar: "bg-destructive", text: "text-destructive" }
  if (percent >= 70) return { bar: "bg-warning", text: "text-warning" }
  return { bar: "bg-success", text: "text-success" }
}

export function UsageMonitorWidget({ className }: UsageMonitorWidgetProps) {
  const [enabled, setEnabled] = React.useState(true)
  const [snapshot, setSnapshot] = React.useState<UsageMonitorSnapshot | null>(null)

  const refreshSnapshot = React.useCallback(async () => {
    const [enabledValue, nextSnapshot] = await Promise.all([
      window.electronAPI.getUsageMonitorEnabled(),
      window.electronAPI.getUsageMonitorSnapshot(),
    ])
    setEnabled(enabledValue)
    setSnapshot(nextSnapshot)
  }, [])

  React.useEffect(() => {
    refreshSnapshot()
    const unsubscribeStats = window.electronAPI.onUsageMonitorStatsChanged(setSnapshot)
    const unsubscribeConfig = window.electronAPI.onUsageMonitorConfigChanged((config: UsageMonitorConfigPayload) => {
      setEnabled(config.enabled)
      setSnapshot((prev) => {
        if (!prev) return prev
        const limit = config.plan === "max5" ? config.limits.max5
                     : config.plan === "max20" ? config.limits.max20
                     : config.limits.pro
        return {
          ...prev,
          plan: config.plan,
          limit,
        }
      })
    })
    return () => {
      unsubscribeStats()
      unsubscribeConfig()
    }
  }, [refreshSnapshot])

  if (!enabled) return null
  if (!snapshot) return null
  if (snapshot.status === "missing") return null

  const percentRaw = snapshot.limit > 0 ? (snapshot.totalTokens / snapshot.limit) * 100 : 0
  const percentSafe = Number.isFinite(percentRaw) ? percentRaw : 0
  const percentClamped = Math.min(100, Math.max(0, Math.round(percentSafe)))
  const { bar, text } = getUsageColor(percentClamped)
  const resetAt = snapshot.resetAtMs
  const remainingLabel = resetAt ? formatTimeRemaining(Math.max(0, resetAt - Date.now())) : "--:--"

  return (
    <div className={cn("px-2 pb-2", className)}>
      <div className="rounded-[8px] border border-foreground/5 bg-background/70 px-2.5 py-2 shadow-minimal">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Usage</span>
          <span className="uppercase">{snapshot.plan}</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-foreground/10 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              bar,
              percentClamped >= 100 && "animate-pulse"
            )}
            style={{ width: `${percentClamped}%` }}
          />
        </div>
        <div className={cn("mt-2 text-[11px]", snapshot.status === "unavailable" ? "text-muted-foreground" : text)}>
          {snapshot.status === "unavailable"
            ? "Usage unavailable"
            : `${percentClamped}% Used - Resets in ${remainingLabel}`}
        </div>
      </div>
    </div>
  )
}
