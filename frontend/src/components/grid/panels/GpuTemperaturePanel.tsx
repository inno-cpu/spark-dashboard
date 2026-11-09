import { useEffect, useState } from 'react'
import { ArcGauge } from '@/components/gauges/ArcGauge'
import { TimeSeriesChart, type ChartSeries } from '@/components/charts/TimeSeriesChart'
import { THRESHOLDS, NVIDIA_THEME } from '@/lib/theme'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice } from './PanelNotice'
import { HardwarePanelBody } from './HardwarePanelBody'
import { useGpuPanelSeries } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

interface HbmPoint {
  timestamp: number
  value: number
}

/**
 * One GPU's core temperature, with the memory junction on the same chart.
 *
 * Two sensors, one plot: a card that shows only the die hides the component that
 * runs hottest on this card. The die line keeps the product's thermal thresholds;
 * the HBM line is drawn plainly and named in the legend.
 *
 * HBM is not in the metrics snapshot (the NVML wrapper in use has only the die
 * sensor), so its current value and its history come from the host endpoints —
 * absent when those have nothing, never zero.
 */
export function GpuTemperaturePanel({ panel }: PanelContentProps) {
  const { resolution, data } = useGpuPanelSeries(panel, 'gpuTemp')
  const index = resolution.status === 'resolved' ? (resolution.gpu.index ?? 0) : 0
  const [hbm, setHbm] = useState<number | null>(null)
  const [hbmSeries, setHbmSeries] = useState<HbmPoint[]>([])

  useEffect(() => {
    if (resolution.status !== 'resolved') return
    let cancelled = false
    const load = async () => {
      try {
        const current = await fetch('/api/host/hbm', { headers: { accept: 'application/json' } })
        if (current.ok) {
          const body = (await current.json()) as { gpus?: Array<{ index: number; hbm_c: number }> }
          const row = (body.gpus ?? []).find((entry) => entry.index === index)
          if (!cancelled) setHbm(row?.hbm_c ?? null)
        }
        const history = await fetch(`/api/host/thermal-history?metric=hbm&window=${panel.window}`, {
          headers: { accept: 'application/json' },
        })
        if (!history.ok) return
        const body = (await history.json()) as {
          series?: Array<{ name?: string; points?: Array<[number, number]> }>
        }
        const match = (body.series ?? []).find((entry) => entry.name === `GPU ${index}`)
        if (!cancelled) {
          setHbmSeries(
            (match?.points ?? []).map(([timestamp, value]) => ({ timestamp: timestamp * 1000, value })),
          )
        }
      } catch {
        /* leave the HBM line out rather than draw a guess */
      }
    }
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [index, panel.window, resolution.status])

  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const value = resolution.gpu.temperature_celsius ?? 0
  const limit = resolution.gpu.power_limit_watts
  const label = gpuLabel(resolution, 'GPU Temp')

  const series: ChartSeries[] = [
    { label: 'core', color: NVIDIA_THEME.healthy, data },
    ...(hbmSeries.length > 0
      ? [{ label: 'HBM', color: '#60a5fa', data: hbmSeries }]
      : []),
  ]

  return (
    <HardwarePanelBody
      device={resolution.gpu.name}
      compact={
        <div className="flex items-baseline gap-2">
          <span className="text-lg tabular-nums text-zinc-100">{value}°C</span>
          <span className="text-[10px] text-zinc-500">HBM {hbm === null ? 'n/a' : `${hbm.toFixed(0)} °C`}</span>
          {limit ? <span className="ml-auto text-[10px] text-zinc-500">limit {limit.toFixed(0)} W</span> : null}
        </div>
      }
      gauge={(sizePx) => (
        <div className="flex flex-col items-center">
          <ArcGauge value={value} label={label} unit="°C" thresholds={THRESHOLDS.gpuTemp} size={sizePx} />
          <span className="mt-0.5 text-[10px] text-zinc-500">
            HBM {hbm === null ? 'n/a' : `${hbm.toFixed(0)} °C`}
          </span>
        </div>
      )}
      chart={<TimeSeriesChart series={series} yDomain={[0, 100]} unit="°C" />}
      below={
        limit ? (
          <div className="px-1 pt-0.5 text-right text-[10px] text-zinc-500">
            power limit <span className="tabular-nums text-zinc-300">{limit.toFixed(0)} W</span>
          </div>
        ) : undefined
      }
    />
  )
}
