import { useEffect, useState } from 'react'
import { formatContextLength } from '@/lib/format'
import { formatGpuName } from '@/lib/modelIdentity'
import { NVIDIA_THEME } from '@/lib/theme'

interface Backend {
  name?: string
  url?: string
  gpu_uuid?: string | null
  model_uid?: string | null
  healthy?: boolean
  draining?: boolean
  in_flight?: number
  requests_served?: number
  max_ctx?: number | null
  last_error?: string | null
}

interface RouterBody {
  backends?: Backend[]
  auth_mode?: string | null
  affinity_mode?: string | null
  sessions?: number | null
  error?: string
}

/**
 * The router's backends, read-only.
 *
 * The router stays the routing implementation: this shows which backends exist,
 * whether each is healthy or draining, and how much traffic it has taken. Drain
 * is deliberately not offered here — it is a state change and belongs behind an
 * explicit confirmation, not a click on a card.
 */
export function RouterBackendsPanel() {
  const [body, setBody] = useState<RouterBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/router/status', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as RouterBody
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

  if (error && !body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Router — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Reading router…</div>

  const backends = body.backends ?? []
  const ready = backends.filter((backend) => backend.healthy).length
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-1.5 py-1">
      {error ? (
        <div className="truncate text-[9px] text-amber-300/80" title={error}>
          stale — showing last update ({error})
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-3 text-[10px] text-zinc-500">
        <span>
          <span className="text-zinc-300">{ready}</span>/{backends.length} ready
        </span>
        <span>auth {body.auth_mode ?? 'n/a'}</span>
        <span>affinity {body.affinity_mode ?? 'n/a'}</span>
        <span>sessions {body.sessions ?? 'n/a'}</span>
      </div>
      <div className="grid min-h-0 flex-1 gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        {backends.map((backend) => {
          const tone = backend.draining
            ? NVIDIA_THEME.warning
            : backend.healthy
              ? NVIDIA_THEME.healthy
              : NVIDIA_THEME.critical
          const gpu = (backend.gpu_uuid ?? '').replace(/^GPU-/, '').slice(0, 8)
          return (
            <div key={backend.name} className="min-w-0 rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
                <span className="text-[11px] font-medium text-zinc-200">{formatGpuName(backend.name)}</span>
                <span className="truncate text-[10px] text-zinc-500">{backend.model_uid ?? 'no model loaded'}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-zinc-500">
                <span>{backend.healthy ? 'healthy' : 'unavailable'}</span>
                <span>{backend.draining ? 'draining' : 'serving'}</span>
                {gpu && <span>gpu {gpu}</span>}
                {backend.max_ctx ? <span>{formatContextLength(backend.max_ctx)}</span> : null}
              </div>
              <div className="mt-1 flex items-baseline gap-2 text-[10px] text-zinc-400">
                <span className="tabular-nums text-zinc-200">{backend.in_flight ?? 0}</span> in flight
                <span className="ml-auto tabular-nums">{backend.requests_served ?? 0} served</span>
              </div>
              {backend.last_error && (
                <div className="mt-0.5 truncate text-[10px] text-amber-300/70" title={backend.last_error}>
                  {backend.last_error.slice(0, 40)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
