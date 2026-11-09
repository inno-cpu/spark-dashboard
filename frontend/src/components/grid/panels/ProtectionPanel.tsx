import { useEffect, useState } from 'react'
import { NVIDIA_THEME } from '@/lib/theme'

interface UnitRow {
  unit: string
  active: string
}

interface ProtectionBody {
  healthy?: boolean
  latch?: boolean
  latch_detail?: string
  guard_heartbeat_age_s?: number | null
  thresholds?: Record<string, number>
  units?: UnitRow[]
}

/**
 * The thermal guard, as state rather than a log: latch, heartbeat freshness and
 * the protection units. Every value comes from the host — the latch file, the
 * heartbeat and systemd — and nothing here can clear or change any of them.
 */
export function ProtectionPanel() {
  const [body, setBody] = useState<ProtectionBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/host/protection', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as ProtectionBody
        if (!cancelled) {
          setBody(payload)
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
  }, [])

  if (error) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Protection — {error}</div>
  }
  if (!body) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Reading protection state…</div>
  }

  const healthy = body.healthy === true
  const latch = body.latch === true
  const tone = latch ? NVIDIA_THEME.critical : healthy ? NVIDIA_THEME.healthy : NVIDIA_THEME.warning
  const age = body.guard_heartbeat_age_s

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
        <span className="text-[11px] font-medium" style={{ color: tone }}>
          {latch ? 'LATCHED' : healthy ? 'Healthy' : 'Attention'}
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">
          guard heartbeat {age === null || age === undefined ? 'missing' : `${age.toFixed(1)} s`}
        </span>
      </div>
      <div className="text-[10px] text-zinc-400">
        latch {latch ? 'present — workloads stopped and starts refused' : 'clear'}
        {latch && body.latch_detail ? ` · ${body.latch_detail.slice(0, 80)}` : ''}
      </div>
      <div className="mt-auto grid grid-cols-2 gap-x-3 gap-y-[2px]">
        {(body.units ?? []).map((unit) => (
          <div key={unit.unit} className="flex items-center gap-1.5 text-[10px]">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: unit.active === 'active' ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical }}
            />
            <span className="truncate text-zinc-500">{unit.unit}</span>
            <span className="ml-auto tabular-nums text-zinc-400">{unit.active}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
