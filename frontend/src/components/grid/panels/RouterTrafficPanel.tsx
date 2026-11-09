import { useEffect, useState } from 'react'
import { TimeSeriesChart, type ChartSeries } from '@/components/charts/TimeSeriesChart'

const COLORS = ['#76B900', '#60a5fa', '#eab308']

interface HistoryBody {
  series?: Array<{ name?: string; unit?: string; axis?: 'left' | 'right'; points?: Array<[number, number]> }>
}

/**
 * Router throughput over time, from the dashboard's own samples of the router's
 * counters. Requests per second, in-flight requests and ready backends; there is no
 * latency line because the router does not report latency.
 */
export function RouterTrafficPanel() {
  const [series, setSeries] = useState<ChartSeries[]>([])
  const [limit, setLimit] = useState(100)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(`/api/router/history?limit=${limit}`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as HistoryBody
        const rows = (body.series ?? [])
          .filter((entry) => (entry.points ?? []).length > 0)
          .map((entry, index) => ({
            label: entry.name ?? `series ${index + 1}`,
            color: COLORS[index % COLORS.length],
            axis: entry.axis,
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
  }, [limit])

  if (error && series.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Router traffic — {error}</div>
  if (series.length === 0) {
    return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Collecting samples…</div>
  }
  return (
    <div className="flex h-full min-h-0 flex-col px-1 py-1">
      {error ? (
        <div className="truncate text-[9px] text-amber-300/80" title={error}>
          stale — showing last update ({error})
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1 pb-0.5 text-[9px] text-zinc-500">
        <span>last</span>
        <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}
                className="rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[9px]">
          <option value={20}>20 samples</option>
          <option value={100}>100 samples</option>
        </select>
      </div>
      <div className="min-h-0 flex-1">
        <TimeSeriesChart series={series} />
      </div>
    </div>
  )
}
