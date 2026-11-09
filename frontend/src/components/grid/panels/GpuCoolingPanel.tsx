import { ArcGauge } from '@/components/gauges/ArcGauge'
import { HBar } from '@/components/gauges/HBar'
import type { PanelContentProps } from '../panelRegistry'
import { GUARD } from '@/lib/theme'
import { GpuPanelNotice } from './PanelNotice'
import { useGpuPanel } from './useGpuPanel'

/**
 * One GPU's thermal picture: die temperature against the guard's thresholds, fan
 * duty, and power against the enforced limit.
 *
 * It exists beside `gpu-overview` because the two answer different questions —
 * "what is this card doing" and "is it staying cool" — and an operator watching
 * cooling wants three of these, not four cards of clocks.
 */
export function GpuCoolingPanel({ panel }: PanelContentProps) {
  const resolution = useGpuPanel(panel)
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const gpu = resolution.gpu
  const temp = gpu.temperature_celsius
  const fan = gpu.fan_speed_percent
  const power = gpu.power_watts
  const limit = gpu.power_limit_watts
  const powerPercent = limit && limit > 0 && power !== null ? Math.min(100, Math.round((power / limit) * 100)) : null

  return (
    <div className="flex h-full min-h-0 w-full items-center gap-3 px-2 py-1">
      <ArcGauge
        value={temp ?? 0}
        max={100}
        label={`GPU ${gpu.index ?? 0}`}
        unit="°C"
        thresholds={GUARD.coreTemp}
        size="clamp(56px, 6vw, 84px)"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[10px] text-zinc-500">
          <span>fan</span>
          <span className="tabular-nums text-zinc-200">
            {fan === null ? 'not reported' : `${fan} %`}
          </span>
        </div>
        {fan !== null && <HBar value={fan} max={100} label="" unit="%" />}
        {powerPercent !== null && (
          <HBar
            value={powerPercent}
            max={100}
            label={`power ${power?.toFixed(1)} / ${limit?.toFixed(0)} W`}
            unit="%"
            thresholds={{ warning: 80, critical: 95 }}
          />
        )}
        <div className="flex justify-between gap-2 text-[10px] text-zinc-500">
          <span>limit</span>
          <span className="tabular-nums text-zinc-300">{limit === null ? 'n/a' : `${limit.toFixed(0)} W`}</span>
        </div>
      </div>
    </div>
  )
}
