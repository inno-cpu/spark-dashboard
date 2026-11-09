import { useEffect, useState } from 'react'
import { NVIDIA_THEME } from '@/lib/theme'

interface RequestRow {
  ts?: number
  backend?: string
  model?: string
  path?: string
  status?: number | null
  duration_ms?: number | null
  prompt_tokens?: number | null
  completion_tokens?: number | null
  tokens_per_sec?: number | null
  stream?: boolean
  rerouted?: boolean
}

/** Last N requests with their token usage — one line per message. */
export function RouterMessagesPanel() {
  const [rows, setRows] = useState<RequestRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/router/requests', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as { requests?: RequestRow[] }
        if (!cancelled) {
          setRows((body.requests ?? []).slice(0, 15))
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

  if (error && rows.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">requests — {error}</div>
  if (rows.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no requests recorded yet</div>

  const time = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleTimeString([], { hour12: false }) : '—')
  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-1">
      {error ? (
        <div className="truncate text-[9px] text-amber-300/80" title={error}>
          stale — showing last update ({error})
        </div>
      ) : null}
      <div className="sticky top-0 flex gap-2 bg-[#151519] pb-0.5 text-[9px] uppercase tracking-wide text-zinc-600">
        <span className="w-14 shrink-0">time</span>
        <span className="w-16 shrink-0">model</span>
        <span className="w-8 shrink-0 text-right">in</span>
        <span className="w-8 shrink-0 text-right">out</span>
        <span className="w-14 shrink-0 text-right">tok/s</span>
        <span className="w-14 shrink-0 text-right">time</span>
        <span className="w-8 shrink-0 text-right">code</span>
        <span className="truncate">note</span>
      </div>
      {rows.map((row, index) => {
        const ok = row.status != null && row.status < 400
        return (
          <div key={`${row.ts}-${index}`} className="flex items-baseline gap-2 border-t border-white/[0.04] py-0.5 font-mono text-[9px] text-zinc-400">
            <span className="w-14 shrink-0 text-zinc-600">{time(row.ts)}</span>
            <span className="w-16 shrink-0 truncate text-zinc-300">{row.model ?? row.backend ?? '—'}</span>
            <span className="w-8 shrink-0 text-right tabular-nums">{row.prompt_tokens ?? '—'}</span>
            <span className="w-8 shrink-0 text-right tabular-nums">{row.completion_tokens ?? '—'}</span>
            <span className="w-14 shrink-0 text-right tabular-nums" style={{ color: NVIDIA_THEME.healthy }}>
              {row.tokens_per_sec == null ? '—' : row.tokens_per_sec.toFixed(0)}
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums">{row.duration_ms == null ? '—' : `${row.duration_ms.toFixed(0)} ms`}</span>
            <span className="w-8 shrink-0 text-right" style={{ color: ok ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical }}>
              {row.status ?? '—'}
            </span>
            <span className="truncate text-zinc-600">
              {row.stream ? 'stream' : 'json'}{row.rerouted ? ' · rerouted' : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}
