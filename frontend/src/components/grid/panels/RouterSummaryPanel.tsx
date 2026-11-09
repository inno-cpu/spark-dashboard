import { useEffect, useState } from 'react'

interface RouterBody {
  backends?: Array<{ healthy?: boolean; draining?: boolean; in_flight?: number }>
  auth_mode?: string | null
  affinity_mode?: string | null
  sessions?: number | null
  sampled_at?: number | string | null
}

/** Router-wide state: readiness, routing mode, session count and sample age. */
export function RouterSummaryPanel() {
  const [body, setBody] = useState<RouterBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

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
          setNow(Date.now())
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

  if (error && !body) return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Router — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Reading router…</div>

  const backends = body.backends ?? []
  const ready = backends.filter((b) => b.healthy).length
  const inFlight = backends.reduce((sum, b) => sum + (b.in_flight ?? 0), 0)
  const sampledAt = (() => {
    const raw = body.sampled_at
    if (typeof raw === 'number') return raw * 1000
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw)
      return Number.isNaN(parsed) ? null : parsed
    }
    return null
  })()
  const age = sampledAt === null ? null : Math.max(0, Math.round((now - sampledAt) / 1000))
  const row = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-2 text-[10px]">
      <span className="text-zinc-500">{label}</span>
      <span className="tabular-nums text-zinc-200">{value}</span>
    </div>
  )
  return (
    <div className="flex h-full min-h-0 flex-col gap-0.5 px-2 py-1.5">
      {error ? (
        <div className="truncate text-[9px] text-amber-300/80" title={error}>
          stale — showing last update ({error})
        </div>
      ) : null}
      {row('backends', `${ready}/${backends.length} ready`)}
      {row('in flight', `${inFlight}`)}
      {row('auth', body.auth_mode ?? 'n/a')}
      {row('affinity', body.affinity_mode ?? 'n/a')}
      {row('sessions', `${body.sessions ?? 0}`)}
      {row('sample age', age === null ? 'n/a' : `${age}s`)}
    </div>
  )
}
