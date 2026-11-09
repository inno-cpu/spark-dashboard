import { useEffect, useState } from 'react'
import { TimeSeriesChart, type ChartSeries } from '@/components/charts/TimeSeriesChart'
import type { PanelContentProps } from '../panelRegistry'

const COLORS = ['#76B900', '#60a5fa', '#eab308', '#c084fc', '#2dd4bf', '#f472b6', '#f97316', '#a3e635', '#38bdf8', '#fb7185', '#818cf8']

interface HistoryBody {
  series?: Array<{ name?: string; unit?: string; points?: Array<[number, number]> }>
}

/**
 * A cooling series from Prometheus. Separate panel types rather than a metric
 * selector because this dashboard has no per-panel config surface yet — the
 * panel type is the choice, and each one names its own series.
 */
function ThermalHistory({ metric, unit, window, yDomain }: { metric: string; unit: string; window: string; yDomain?: [number, number] }) {
  const [series, setSeries] = useState<ChartSeries[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(`/api/host/thermal-history?metric=${metric}&window=${window}`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as HistoryBody
        const rows = (body.series ?? [])
          .filter((entry) => (entry.points ?? []).length > 0)
          .map((entry, index) => ({
            label: entry.name ?? `series ${index + 1}`,
            color: COLORS[index % COLORS.length],
            data: (entry.points ?? []).map(([timestamp, value]) => ({ timestamp: timestamp * 1000, value })),
          }))
        if (!cancelled) {
          setSeries(rows)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'unreachable')
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [metric, window])

  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">History — {error}</div>
  if (series.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">No samples yet.</div>

  return (
    <div className="h-full w-full px-1 py-1">
      <TimeSeriesChart series={series} unit={unit} yDomain={yDomain} />
    </div>
  )
}

export function HbmHistoryPanel({ panel }: PanelContentProps) {
  return <ThermalHistory metric="hbm" unit="C" window={panel.window} />
}

export function FanHistoryPanel({ panel }: PanelContentProps) {
  return <ThermalHistory metric="fans" unit="rpm" window={panel.window} yDomain={[0, 13000]} />
}

export function ChassisTempPanel({ panel }: PanelContentProps) {
  return <ThermalHistory metric="chassis" unit="C" window={panel.window} />
}

export function GpuPowerHistoryPanel({ panel }: PanelContentProps) {
  return <ThermalHistory metric="power_total" unit="W" window={panel.window} />
}

export function DutyHistoryPanel({ panel }: PanelContentProps) {
  return <ThermalHistory metric="duty" unit="%" window={panel.window} yDomain={[0, 100]} />
}

export function InletHistoryPanel({ panel }: PanelContentProps) {
  return <ThermalHistory metric="inlet" unit="C" window={panel.window} />
}
