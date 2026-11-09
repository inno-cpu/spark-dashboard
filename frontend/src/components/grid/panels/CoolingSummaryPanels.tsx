import { useEffect, useState } from 'react'
import { HBar } from '@/components/gauges/HBar'
import { NVIDIA_THEME } from '@/lib/theme'

interface CoolingSummary {
  hottest_hbm_c?: number | null
  hbm_ceiling_c?: number | null
  fan_duty_pct?: number | null
  zone_count?: number
  fan_now_max_rpm?: number | null
  inlet_c?: number | null
  guard_warnings_24h?: number | null
  guard_criticals_24h?: number | null
  gpu_power_total_w?: number | null
  profile?: string
  fan_ownership?: string
  smfc_active?: boolean
  guard_active?: boolean
  watchdog_armed?: boolean
  curve_points?: number
}

function useSummary() {
  const [body, setBody] = useState<CoolingSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/host/cooling-summary', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as CoolingSummary
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
  return { body, error }
}

function Chip({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-white/[0.06] px-1.5 py-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span
        className="text-[10px] text-zinc-300"
        style={good === undefined ? undefined : { color: good ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical }}
      >
        {value}
      </span>
    </span>
  )
}

/** The cooling page's summary strip: the numbers an operator checks first. */
export function CoolingSummaryPanel() {
  const { body, error } = useSummary()
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Cooling summary — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Reading cooling state…</div>

  const events = (body.guard_warnings_24h ?? 0) + (body.guard_criticals_24h ?? 0)
  const row = (label: string, value: string, note?: string) => (
    <div className="flex items-baseline justify-between gap-2 text-[10px]">
      <span className="shrink-0 uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="truncate text-right tabular-nums text-zinc-200">
        {value}
        {note ? <span className="ml-1 text-zinc-500">{note}</span> : null}
      </span>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      {row('hottest hbm', body.hottest_hbm_c == null ? 'n/a' : `${body.hottest_hbm_c.toFixed(0)} °C`, body.hbm_ceiling_c ? `ceil ${body.hbm_ceiling_c.toFixed(0)}` : undefined)}
      {row('gpu power', body.gpu_power_total_w == null ? 'n/a' : `${body.gpu_power_total_w.toFixed(0)} W`)}
      {row('fan duty', body.fan_duty_pct == null ? 'n/a' : `${body.fan_duty_pct} %`, `${body.zone_count ?? '?'} zones`)}
      {row('inlet', body.inlet_c == null ? 'n/a' : `${body.inlet_c.toFixed(0)} °C`)}
      {row('guard 24 h', `${events}`, `${body.guard_warnings_24h ?? 0}w / ${body.guard_criticals_24h ?? 0}c`)}
      <div className="mt-auto flex flex-wrap gap-1 pt-0.5">
        <Chip label="fan" value={body.fan_ownership ?? 'n/a'} good={body.fan_ownership === 'HELD'} />
        <Chip label="smfc" value={body.smfc_active ? 'active' : 'down'} good={body.smfc_active} />
        <Chip label="guard" value={body.guard_active ? 'active' : 'down'} good={body.guard_active} />
        <Chip label="wd" value={body.watchdog_armed ? 'ARMED' : 'off'} good={body.watchdog_armed} />
        <Chip label="curve" value={`${body.profile ?? ''} ${body.curve_points ?? 0}p`} />
      </div>
    </div>
  )
}

/** Fan duty as its own card: the number, the bar, and the ceiling it is measured against. */
export function FanDutyPanel() {
  const { body, error } = useSummary()
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Fan duty — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Reading duty…</div>
  const duty = body.fan_duty_pct ?? 0
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-2 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl leading-none tabular-nums text-zinc-100">{duty}</span>
        <span className="text-[11px] text-zinc-500">% duty</span>
        <span className="ml-auto text-[10px] text-zinc-500">
          {body.fan_now_max_rpm ? `${body.fan_now_max_rpm} rpm now` : 'rpm n/a'}
        </span>
      </div>
      <HBar value={duty} max={100} label="" unit="%" thresholds={{ warning: 80, critical: 95 }} />
      <div className="text-[10px] text-zinc-500">
        zone arbitration across {body.zone_count ?? '?'} zone(s) · {body.fan_ownership === 'HELD' ? 'smfc holds the fans' : 'fans not held'}
      </div>
    </div>
  )
}
