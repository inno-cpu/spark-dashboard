import { useEffect, useState } from 'react'
import { NVIDIA_THEME } from '@/lib/theme'

interface UnitRow {
  unit: string
  active: string
  enabled?: string
}

interface ProtectionBody {
  healthy?: boolean
  latch?: boolean
  guard_heartbeat_age_s?: number | null
  thresholds?: Record<string, number>
  units?: UnitRow[]
  c80?: { last_line?: string | null; lines?: string[] | null; marker?: boolean; restore_marker?: string }
  guard?: {
    last_line?: string | null
    heartbeat_age_s?: number | null
    config?: Record<string, string>
    last_warning?: string | null
    last_critical?: string | null
    lines?: string[] | null
  }
  smfc?: { last_line?: string | null }
}

function useProtection() {
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
  return { body, error }
}

/** A small monospace tail, scrollable — the shape HyperQwen used for these cards. */
function LogTail({ lines, empty }: { lines?: string[] | null; empty: string }) {
  if (!lines || lines.length === 0) {
    return <div className="mt-auto text-[10px] text-zinc-500">{empty}</div>
  }
  return (
    <div className="mt-auto min-h-0 flex-1 overflow-y-auto rounded border border-white/[0.06] bg-black/30 px-1.5 py-1">
      <pre className="whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.35] text-zinc-400">
        {lines.join('\n')}
      </pre>
    </div>
  )
}

function State({ name, active }: { name: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 w-2 rounded-full" style={{ background: active ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical }} />
      <span className="text-[11px]" style={{ color: active ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical }}>
        {active ? `${name} running` : `${name} down`}
      </span>
    </div>
  )
}

/** The C.80 watchdog: what restores the original fan curve if smfc dies. */
export function C80WatchdogPanel() {
  const { body, error } = useProtection()
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">C.80 — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Reading C.80…</div>
  const unit = (body.units ?? []).find((row) => row.unit === 'smfc-c80-monitor')
  const active = unit?.active === 'active'
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <State name="C.80 watchdog" active={active} />
        <span className="ml-auto text-[10px] text-zinc-500">
          unit {unit?.active ?? 'unknown'}{unit?.enabled ? ` / ${unit.enabled}` : ''}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-[10px] text-zinc-500">
        <span>restores the original fan curve if smfc stops</span>
        <span>
          restore marker <span className="text-zinc-300">{body.c80?.marker ? 'present' : 'none'}</span>
        </span>
      </div>
      <LogTail lines={body.c80?.lines} empty="no log lines yet" />
    </div>
  )
}

/** The thermal guard: heartbeat, thresholds, latch. */
export function ThermalGuardPanel() {
  const { body, error } = useProtection()
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Guard — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Reading guard…</div>
  const unit = (body.units ?? []).find((row) => row.unit === 'cmp-gpu-guard')
  const active = unit?.active === 'active'
  const age = body.guard?.heartbeat_age_s ?? body.guard_heartbeat_age_s
  const thresholds = body.thresholds ?? {}
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <State name="Thermal guard" active={active} />
        <span className="ml-auto text-[10px] text-zinc-500">
          heartbeat {age === null || age === undefined ? 'missing' : `${age.toFixed(1)} s`}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400">
        <span>core {String(thresholds.CORE_WARN ?? '?')} / {String(thresholds.CORE_CRIT ?? '?')} °C</span>
        <span>HBM {String(thresholds.HBM_WARN ?? '?')} / {String(thresholds.HBM_CRIT ?? '?')} °C</span>
        <span>latch {body.latch ? 'present' : 'clear'}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-zinc-500">
        <span>sustain {body.guard?.config?.SUSTAIN_SECONDS ?? '?'} s</span>
        <span>poll {body.guard?.config?.POLL ?? '?'} s</span>
        <span className="truncate" title={body.guard?.config?.ACTION_SCRIPT ?? ''}>
          action {body.guard?.config?.ACTION_SCRIPT ? body.guard.config.ACTION_SCRIPT.split('/').pop() : 'none'}
        </span>
      </div>
      <div className="space-y-0.5 text-[10px] text-zinc-400">
        <div className="truncate" title={body.guard?.last_warning ?? ''}>
          last warning: {body.guard?.last_warning ?? 'none in journal'}
        </div>
        <div className="truncate" title={body.guard?.last_critical ?? ''}>
          last critical: {body.guard?.last_critical ?? 'none in journal'}
        </div>
      </div>
      <LogTail lines={body.guard?.lines} empty="no guard log lines yet" />
    </div>
  )
}
