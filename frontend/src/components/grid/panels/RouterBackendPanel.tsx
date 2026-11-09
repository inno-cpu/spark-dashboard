import { useEffect, useState } from 'react'
import { ArcGauge } from '@/components/gauges/ArcGauge'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { engineKey } from '@/lib/identity'
import { formatProfileLabel } from '@/lib/modelIdentity'
import { engineSeries } from '@/lib/metricsHistoryStore'
import { associateRouterBackend, backendModelUid } from '@/lib/routerEngine'
import { NVIDIA_THEME, GUARD, thresholdColor } from '@/lib/theme'
import type { PanelContentProps } from '../panelRegistry'

interface BackendBody {
  backend?: Record<string, unknown>
  error?: string
}

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A label row over a thin track. Sized for a card a quarter of the page wide. */
function Meter({
  label,
  value,
  max,
  display,
  thresholds,
}: {
  label: string
  value: number | null
  max: number
  display: string
  thresholds?: { warning: number; critical: number }
}) {
  const pct = value === null || max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100))
  const color = value === null
    ? '#3f3f46'
    : thresholds
      ? thresholdColor(pct, thresholds.warning, thresholds.critical)
      : NVIDIA_THEME.healthy
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1 text-[9px] uppercase tracking-wide">
        <span className="truncate text-zinc-500">{label}</span>
        <span className="shrink-0 tabular-nums text-zinc-300">{display}</span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

/** No axes, no labels — a shape for a card this narrow. The page chart has axes. */
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1e-9)
  const min = Math.min(...values, 0)
  const span = Math.max(max - min, 1e-9)
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100
      const y = 28 - ((value - min) / span) * 26
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-[30px] w-full shrink-0">
      <polyline points={points} fill="none" stroke={NVIDIA_THEME.healthy} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px]">
      <span className="text-zinc-500">{label}</span>
      <span className="tabular-nums text-zinc-200">{value}</span>
    </span>
  )
}

/**
 * One router backend: operational state from the router, inference state from the
 * engine snapshot Spark already collects — the same values the native Throughput,
 * Latency, Cache and Speculative panels show.
 */
export function RouterBackendPanel({ panel }: PanelContentProps) {
  const binding = panel.binding
  const name = binding.kind === 'backend' ? binding.name : null
  const [body, setBody] = useState<BackendBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggleDrain = async () => {
    const draining = body?.backend?.draining === true
    if (!window.confirm(`${draining ? 'Undrain' : 'Drain'} ${name}?`)) return
    try {
      await fetch(`/api/router/drain?name=${encodeURIComponent(name ?? '')}&on=${!draining}`, { method: 'POST' })
    } catch {
      /* the next poll shows the effective state */
    }
  }

  const snapshot = useLatestSnapshot()
  const engines = snapshot?.engines ?? []
  const association = associateRouterBackend(engines, body?.backend ?? null)
  const uid = backendModelUid(body?.backend ?? null)

  // The inventory carries the human model/profile name; the engine snapshot's own
  // model name is the served id, which reads like the uid.
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  useEffect(() => {
    const target = body?.backend ? backendModelUid(body.backend) : null
    if (!target) return
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/models', { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const body = (await response.json()) as { models?: Array<{ uid?: string; model_name?: string; profile?: string }> }
        const rows = (body.models ?? []) as Array<{ uid?: string; model_name?: string; profile?: string }>
        const row = rows.find((entry) => entry.uid === target)
        const label = row ? formatProfileLabel(row.profile ?? row.model_name) : null
        if (!cancelled) setModelLabel(label)
      } catch {
        /* keep the previous label */
      }
    }
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [body])

  const engine = association.status === 'resolved' ? association.engine : null
  const metrics = engine?.metrics ?? null
  const seriesKey = engine ? engineSeries('tps', engineKey(engine)) : ''
  const history = useMetricSeries(seriesKey, panel.window)

  useEffect(() => {
    if (!name) return
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(`/api/router/backend?name=${encodeURIComponent(name)}`, {
          headers: { accept: 'application/json' },
        })
        if (response.status === 404) throw new Error(`no backend ${name}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as BackendBody
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
  }, [name])

  if (!name) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-zinc-500">
        Choose a backend in this panel&apos;s settings.
      </div>
    )
  }
  if (error && !body?.backend) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">{name} — {error}</div>
  }
  if (!body?.backend) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Reading {name}…</div>
  }

  const b = body.backend
  const healthy = b.healthy === true
  const draining = b.draining === true
  const idle = !healthy && !draining && uid !== null
  const tone = draining ? NVIDIA_THEME.warning : healthy ? NVIDIA_THEME.healthy : idle ? NVIDIA_THEME.warning : NVIDIA_THEME.critical
  const routerKv = num(b.kv_cache_pct)
  const vramMiB = num(b.vram_mb)
  // Hardware telemetry belongs to the physical GPU slot, not to the engine
  // association. If the router has not resolved the model yet (or the engine is
  // idle), still show that GPU's temperature/power/VRAM instead of N/A.
  const backendGpuIndex = (() => {
    const match = /^gpu(\d+)$/.exec(text(b.name))
    return match ? Number(match[1]) : null
  })()
  const gpu = snapshot?.gpus?.find(
    (row) => row.index !== null && row.index !== undefined && engine?.gpu_indexes?.includes(row.index),
  ) ?? snapshot?.gpus?.find(
    (row) => backendGpuIndex !== null && row.index === backendGpuIndex,
  )
  const totalMiB = gpu?.memory_total_bytes ? gpu.memory_total_bytes / (1024 * 1024) : null

  const kv = metrics?.kv_cache_percent ?? routerKv
  const prefixRate = metrics?.prefix_cache_hit_rate
  // The engine reports this as a percentage (vLLM converts the ratio itself);
  // multiplying again produced values like 5563%.
  const prefix = prefixRate !== null && prefixRate !== undefined ? prefixRate : num(b.prefix_cache_hit_pct)
  // Already a percentage: accepted/draft*100 (see EngineMetrics), not a fraction.
  const accept = metrics?.spec_decode_acceptance_rate ?? null

  const kind = text(b.kind)
  const statusLabel = draining ? 'draining' : healthy ? 'ready' : idle ? 'engine not loaded' : 'unavailable'
  const associationNote = association.status === 'unavailable'
    ? association.reason === 'no-identity'
      ? kind === 'vllm'
        ? 'legacy vLLM endpoint — not a Xinference engine'
        : 'this backend names no model'
      : association.reason === 'not-loaded'
        ? `no engine serving ${uid ?? 'its model'}`
        : `${association.candidates} engines claim that uid`
    : 'waiting for engine snapshot'

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-2 py-1.5">
      {error ? (
        <div className="truncate text-[9px] text-amber-300/80" title={error}>
          stale — showing last update ({error})
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
        <span className="truncate text-[11px] font-medium text-zinc-200">
          {modelLabel ?? engine?.model?.name ?? (kind === 'vllm' ? 'legacy vllm' : 'no model')}
        </span>
        <button
          type="button"
          onClick={() => void toggleDrain()}
          className="ml-auto shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
        >
          {draining ? 'undrain' : 'drain'}
        </button>
        <span className="shrink-0 text-[10px]" style={{ color: tone }}>{statusLabel}</span>
      </div>

      <div className="flex min-h-0 flex-1 items-center gap-2">
        <div className="flex w-[88px] shrink-0 flex-col items-center justify-center">
          <ArcGauge
            value={kv ?? undefined}
            max={100}
            label="kv cache"
            unit="%"
            size={88}
            thresholds={{ warning: 70, critical: 90 }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
          <Meter
            label="vram"
            value={totalMiB ? (vramMiB ?? 0) / 1024 : vramMiB}
            max={totalMiB ? totalMiB / 1024 : Math.max(vramMiB ?? 1, 1)}
            display={
              vramMiB === null
                ? 'n/a'
                : totalMiB
                  ? `${(vramMiB / 1024).toFixed(0)} / ${(totalMiB / 1024).toFixed(0)} GiB`
                  : `${vramMiB.toFixed(0)} MiB`
            }
            thresholds={{ warning: 85, critical: 95 }}
          />
          <Meter
            label="prefix hit"
            value={prefix}
            max={100}
            display={prefix === null ? 'n/a' : `${prefix.toFixed(0)}%`}
          />
          <Meter
            label="spec accept"
            value={accept}
            max={100}
            display={accept === null ? 'n/a' : `${accept.toFixed(0)}%`}
          />
        <Meter
          label="temp"
          value={gpu?.temperature_celsius ?? null}
          max={90}
          display={gpu?.temperature_celsius == null ? 'n/a' : `${gpu.temperature_celsius.toFixed(0)} / 90 °C`}
          thresholds={GUARD.coreTemp}
        />
        <Meter
          label="power"
          value={gpu?.power_watts ?? null}
          max={gpu?.power_limit_watts ?? GUARD.powerLimitWatts}
          display={gpu?.power_watts == null ? 'n/a' : `${gpu.power_watts.toFixed(0)} / ${gpu.power_limit_watts?.toFixed(0) ?? '—'} W`}
          thresholds={{ warning: 150, critical: 175 }}
        />
        </div>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-xl leading-none tabular-nums text-zinc-100">
          {metrics?.tokens_per_sec == null ? '—' : metrics.tokens_per_sec.toFixed(0)}
        </span>
        <span className="text-[9px] uppercase tracking-wide text-zinc-500">tok/s</span>
        <span className="ml-auto text-[10px] tabular-nums text-zinc-400">
          {metrics?.prompt_tokens_per_sec == null ? '—' : metrics.prompt_tokens_per_sec.toFixed(0)} prefill
        </span>
      </div>



      {history.length > 1 ? (
        <Sparkline values={history.map((point) => point.value)} />
      ) : (
        <div className="text-[9px] leading-tight text-zinc-500">
          {metrics ? 'collecting throughput samples…' : `engine metrics unavailable — ${associationNote}`}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        <Chip label="in flight" value={`${num(b.router_in_flight) ?? num(b.in_flight) ?? 0}`} />
        <Chip label="waiting" value={`${num(b.vllm_waiting) ?? num(b.waiting) ?? 0}`} />
        <Chip label="ttft" value={metrics?.ttft_ms == null ? '—' : `${metrics.ttft_ms.toFixed(0)} ms`} />
        <Chip label="tpot" value={metrics?.inter_token_latency_ms == null ? '—' : `${metrics.inter_token_latency_ms.toFixed(1)} ms`} />
        <Chip label="served" value={`${num(b.requests_served) ?? 0}`} />

      </div>

      {text(b.last_error) && !idle ? (
        <div className="truncate text-[9px] text-amber-300/60" title={text(b.last_error)}>
          {text(b.last_error).includes('ConnectError') ? 'backend unreachable' : text(b.last_error).slice(0, 40)}
        </div>
      ) : null}
    </div>
  )
}
