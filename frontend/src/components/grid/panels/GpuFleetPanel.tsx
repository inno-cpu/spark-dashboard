import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { GUARD, thresholdColor } from '@/lib/theme'

/** One horizontal track, used for the four per-GPU measures. */
function Track({ value, max, color }: { value: number | null; max: number; color: string }) {
  const pct = value === null || max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/**
 * Every GPU at once: one row per card with temperature, power, utilisation and
 * VRAM, and a fleet header (total draw, hottest card). Complements the per-GPU
 * panels — this one cannot be pinned to a single card, so it binds nothing.
 */
export function GpuFleetPanel() {
  const snapshot = useLatestSnapshot()
  const gpus = snapshot?.gpus ?? []

  if (gpus.length === 0) {
    return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no GPUs reported</div>
  }

  const totalPower = gpus.reduce((sum, gpu) => sum + (gpu.power_watts ?? 0), 0)
  const hottest = gpus.reduce((best, gpu) => Math.max(best, gpu.temperature_celsius ?? 0), 0)
  const capacityGiB = gpus.reduce((sum, gpu) => sum + (gpu.memory_total_bytes ?? 0), 0) / 1024 ** 3

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-1.5 py-1">
      <div className="flex items-baseline gap-2 text-[10px] text-zinc-500">
        <span className="text-zinc-300">{gpus.length} GPUs</span>
        <span>power <span className="tabular-nums text-zinc-200">{totalPower.toFixed(0)} W</span></span>
        <span>hottest <span className="tabular-nums text-zinc-200">{hottest.toFixed(0)} °C</span></span>
        <span className="ml-auto">vram <span className="tabular-nums text-zinc-200">{capacityGiB.toFixed(0)} GiB</span></span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-1 sm:grid-cols-2">
        {gpus.map((gpu, position) => {
          const index = gpu.index ?? position
          const temp = gpu.temperature_celsius
          const power = gpu.power_watts
          const limit = gpu.power_limit_watts ?? GUARD.powerLimitWatts
          const util = gpu.utilization_percent
          const used = (gpu.memory_used_bytes ?? 0) / 1024 ** 3
          const total = (gpu.memory_total_bytes ?? 0) / 1024 ** 3
          const tempColor = temp === null ? '#71717a' : thresholdColor(temp, GUARD.coreTemp.warning, GUARD.coreTemp.critical)
          return (
            <div key={index} className="flex flex-col justify-center gap-0.5 rounded border border-white/[0.06] px-1.5 py-1">
              <div className="flex items-baseline justify-between text-[10px]">
                <span className="text-zinc-300">gpu{index}</span>
                <span className="tabular-nums text-zinc-400">
                  {temp === null ? '—' : `${temp.toFixed(0)} °C`} · {power === null ? '—' : `${power.toFixed(0)}${gpu.power_limit_watts == null ? '' : `/${limit.toFixed(0)}`} W`}
                </span>
              </div>
              <Track value={temp} max={90} color={tempColor} />
              <div className="flex items-baseline justify-between text-[9px] text-zinc-500">
                <span>util {util === null ? '—' : `${util.toFixed(0)} %`}</span>
                <span>{total ? `${used.toFixed(0)}/${total.toFixed(0)} GiB` : 'vram n/a'}</span>
              </div>
              <Track value={util} max={100} color="#60a5fa" />
              <Track value={total ? used : null} max={total || 1} color="#a855f7" />
            </div>
          )
        })}
      </div>
    </div>
  )
}
