import { useEffect, useState } from 'react'
import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import type { PanelContentProps } from '../panelRegistry'
import { GUARD } from '@/lib/theme'
import { GpuPanelNotice } from './PanelNotice'
import { useGpuPanel } from './useGpuPanel'

/**
 * One GPU, as a card: the whole of what the metrics snapshot carries for it.
 *
 * A composite rather than another single-metric panel because the operator
 * asked for a card they can put four of on a page — one per GPU — and read at a
 * glance. It binds exactly like `gpu-temperature` does, so pointing it at
 * another card is the native Source selector, and a template can bind it too.
 */
export function GpuOverviewPanel({ panel }: PanelContentProps) {
  const resolution = useGpuPanel(panel)
  // The memory junction is not in the snapshot (NVML wrapper exposes only the die
  // sensor), so it comes from the host endpoint keyed by GPU index.
  const [hbm, setHbm] = useState<number | null>(null)
  const gpuIndex = resolution.status === 'resolved' ? (resolution.gpu.index ?? 0) : 0
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/host/hbm', { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const body = (await response.json()) as { gpus?: Array<{ index: number; hbm_c: number }> }
        const row = (body.gpus ?? []).find((entry) => entry.index === gpuIndex)
        if (!cancelled) setHbm(row?.hbm_c ?? null)
      } catch {
        /* leave the line out rather than invent a value */
      }
    }
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [gpuIndex])
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const gpu = resolution.gpu
  const index = gpu.index ?? 0
  const powerLimit = gpu.power_limit_watts
  const power = gpu.power_watts
  const powerPercent = powerLimit && powerLimit > 0 && power !== null
    ? Math.min(100, Math.round((power / powerLimit) * 100))
    : null
  const memTotal = gpu.memory_total_bytes ?? 0
  const memUsed = gpu.memory_used_bytes ?? 0
  const memPercent = memTotal > 0 ? Math.min(100, Math.round((memUsed / memTotal) * 100)) : null
  const util = gpu.utilization_percent
  const temp = gpu.temperature_celsius

  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5 px-1.5 py-1">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-[11px] font-medium text-zinc-300">GPU {index}</span>
        <span className="truncate text-[10px] text-zinc-500">{gpu.name ?? 'unknown device'}</span>
      </div>

      <div className="flex min-h-0 items-center gap-2">
        <div className="flex shrink-0 flex-col items-center">
          <ArcGauge
            value={temp ?? 0}
            max={100}
            label="temp"
            unit="°C"
            thresholds={GUARD.coreTemp}
            size="clamp(52px, 5vw, 68px)"
          />
          <span className="mt-0.5 text-[10px] text-zinc-500">
            HBM {hbm === null ? 'n/a' : `${hbm.toFixed(0)} °C`}
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {powerPercent !== null && (
            <HBar
              value={powerPercent}
              max={100}
              label={`power ${power?.toFixed(1)} W / ${powerLimit?.toFixed(0)} W`}
              unit="%"
              thresholds={{ warning: 80, critical: 95 }}
            />
          )}
          {memPercent !== null && (
            <HBar
              value={memPercent}
              max={100}
              label={`VRAM ${gb(memUsed)} / ${gb(memTotal)} GiB`}
              unit="%"
            />
          )}
          {util !== null && (
            <HBar value={util} max={100} label={`util ${Math.round(util)} %`} unit="%" />
          )}
        </div>
      </div>

      <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-[2px] text-[10px]">
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">graphics</dt>
          <dd className="tabular-nums text-zinc-300">
            {gpu.clock_graphics_mhz === null ? 'n/a' : `${Math.round(gpu.clock_graphics_mhz)} MHz`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">memory</dt>
          <dd className="tabular-nums text-zinc-300">
            {gpu.clock_memory_mhz === null ? 'n/a' : `${Math.round(gpu.clock_memory_mhz)} MHz`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">fan</dt>
          <dd className="tabular-nums text-zinc-300">
            {gpu.fan_speed_percent === null ? 'n/a' : `${Math.round(gpu.fan_speed_percent)} %`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">pcie</dt>
          <dd className="tabular-nums text-zinc-300">
            {gpu.pcie_rx_bytes_per_sec === null && gpu.pcie_tx_bytes_per_sec === null
              ? 'n/a'
              : `${((gpu.pcie_rx_bytes_per_sec ?? 0) / 1e6).toFixed(0)}/${((gpu.pcie_tx_bytes_per_sec ?? 0) / 1e6).toFixed(0)} MB/s`}
          </dd>
        </div>
      </dl>
    </div>
  )
}
