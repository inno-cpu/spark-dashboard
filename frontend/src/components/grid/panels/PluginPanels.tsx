/**
 * The generic plugin panels: status, metric, table, action and event log.
 *
 * One implementation each, built into the host once. What a panel points at
 * comes from the panel's `config` in the dashboard document, so a plugin adds a
 * panel by writing a template rather than by shipping React — and a plugin that
 * is disabled or removed leaves its panels rendering a plain explanation in the
 * slot the operator put them in, never a broken page.
 *
 * All traffic goes to `/api/plugins/<id>/backend<path>`, which Spark proxies to
 * the plugin host. The browser never learns the host's port.
 */

import { useCallback, useEffect, useState } from 'react'
import type { DashboardPanel } from '@/lib/dashboard/schema'

interface PanelConfig {
  plugin?: string
  path?: string
  fields?: Array<{ label?: string; key?: string; unit?: string }>
  healthy_key?: string
  button?: string
  method?: string
  result_key?: string
  result_prefix?: string
  value_key?: string
  unit?: string
  columns?: Array<{ key?: string; label?: string }>
  rows_key?: string
  lines_key?: string
  refresh_s?: number
}

type Load<T> =
  | { state: 'loading' }
  | { state: 'ok'; data: T }
  | { state: 'unavailable'; detail: string }
  | { state: 'disabled' }
  | { state: 'error'; detail: string }

function configOf(panel: DashboardPanel): PanelConfig {
  return (panel.config ?? {}) as PanelConfig
}

function backendUrl(config: PanelConfig, path: string): string | null {
  if (!config.plugin) return null
  return `/api/plugins/${encodeURIComponent(config.plugin)}/backend${path.startsWith('/') ? path : `/${path}`}`
}

async function readBody(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string }
    return body.detail || body.error || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

/** Reads a backend path, mapping every failure to a state the panel can show. */
function useBackend(config: PanelConfig, path: string | undefined, refreshSeconds?: number) {
  const [result, setResult] = useState<Load<unknown>>({ state: 'loading' })
  const url = path === undefined ? null : backendUrl(config, path)

  const load = useCallback(async () => {
    if (url === null) {
      setResult({ state: 'error', detail: 'panel has no plugin or path in its config' })
      return
    }
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (response.status === 409) return setResult({ state: 'disabled' })
      if (response.status === 404) return setResult({ state: 'unavailable', detail: 'plugin not installed' })
      // 502/503 come from Spark's proxy, not from the plugin: the host is down or
      // the backend is unreachable, which is "unavailable", not a backend error.
      if (response.status === 502 || response.status === 503)
        return setResult({ state: 'unavailable', detail: 'plugin host unreachable' })
      if (!response.ok) return setResult({ state: 'error', detail: await readBody(response) })
      setResult({ state: 'ok', data: await response.json() })
    } catch (error) {
      setResult({ state: 'unavailable', detail: error instanceof Error ? error.message : 'plugin host unreachable' })
    }
  }, [url])

  useEffect(() => {
    void load()
    if (!refreshSeconds) return
    const timer = setInterval(() => void load(), Math.max(2, refreshSeconds) * 1000)
    return () => clearInterval(timer)
  }, [load, refreshSeconds])

  return { result, reload: load }
}

const MUTED = 'text-[11px] text-zinc-500 leading-snug'

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="h-full w-full flex flex-col justify-center px-3 py-2 overflow-hidden">{children}</div>
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Frame>
      <p className={MUTED}>{children}</p>
    </Frame>
  )
}

function describe(result: Load<unknown>): string | null {
  if (result.state === 'loading') return 'Loading…'
  if (result.state === 'disabled') return 'Plugin disabled.'
  if (result.state === 'unavailable') return `Plugin unavailable — ${result.detail}`
  if (result.state === 'error') return `Backend error — ${result.detail}`
  return null
}

export function PluginStatusPanel({ panel }: { panel: DashboardPanel }) {
  const config = configOf(panel)
  const { result } = useBackend(config, config.path, config.refresh_s ?? 10)
  const line = describe(result)
  if (line) return <Notice>{line}</Notice>

  const data = (result as { data: Record<string, unknown> }).data
  const fields = config.fields ?? []
  const healthy = config.healthy_key ? Boolean(data[config.healthy_key]) : true

  return (
    <Frame>
      <div className="flex items-center gap-2 mb-1">
        <span className={`h-2 w-2 rounded-full ${healthy ? 'bg-[#76B900]' : 'bg-amber-400'}`} />
        <span className="text-[11px] uppercase tracking-wider text-zinc-400">
          {healthy ? 'Healthy' : 'Degraded'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {fields.map((field) => (
          <div key={field.key ?? field.label} className="truncate">
            <div className="text-[10px] text-zinc-500">{field.label ?? field.key}</div>
            <div className="text-sm text-zinc-200 tabular-nums">
              {data[field.key ?? ''] === undefined ? '—' : String(data[field.key ?? ''])}
              {field.unit ? <span className="text-[10px] text-zinc-500"> {field.unit}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  )
}

export function PluginMetricPanel({ panel }: { panel: DashboardPanel }) {
  const config = configOf(panel)
  const { result } = useBackend(config, config.path, config.refresh_s ?? 10)
  const line = describe(result)
  if (line) return <Notice>{line}</Notice>

  const data = (result as { data: Record<string, unknown> }).data
  const value = config.value_key ? data[config.value_key] : undefined
  return (
    <Frame>
      <div className="text-2xl text-zinc-100 tabular-nums">
        {value === undefined ? '—' : String(value)}
        {config.unit ? <span className="text-xs text-zinc-500"> {config.unit}</span> : null}
      </div>
    </Frame>
  )
}

export function PluginTablePanel({ panel }: { panel: DashboardPanel }) {
  const config = configOf(panel)
  const { result } = useBackend(config, config.path, config.refresh_s ?? 15)
  const line = describe(result)
  if (line) return <Notice>{line}</Notice>

  const data = (result as { data: Record<string, unknown> }).data
  const rows = (config.rows_key ? data[config.rows_key] : data) as Array<Record<string, unknown>> | undefined
  const columns = config.columns ?? []
  if (!Array.isArray(rows) || rows.length === 0) return <Notice>No rows.</Notice>

  return (
    <Frame>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-zinc-500 text-left">
            {columns.map((column) => (
              <th key={column.key} className="font-normal pr-2">{column.label ?? column.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((row, index) => (
            <tr key={index} className="text-zinc-300">
              {columns.map((column) => (
                <td key={column.key} className="pr-2 truncate tabular-nums">
                  {row[column.key ?? ''] === undefined ? '—' : String(row[column.key ?? ''])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  )
}

export function PluginActionPanel({ panel }: { panel: DashboardPanel }) {
  const config = configOf(panel)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const run = async () => {
    const url = config.path === undefined ? null : backendUrl(config, config.path)
    if (url === null) {
      setFailure('panel has no plugin or path in its config')
      return
    }
    if (!window.confirm(`Run ${config.path ?? 'plugin action'}?`)) return
    setPending(true)
    setFailure(null)
    try {
      const response = await fetch(url, { method: config.method ?? 'POST' })
      if (response.status === 409) return setFailure('Plugin disabled.')
      if (response.status === 404) return setFailure('Plugin not installed.')
      if (response.status === 502 || response.status === 503) return setFailure('Plugin host unreachable.')
      if (!response.ok) return setFailure(await readBody(response))
      const body = (await response.json()) as Record<string, unknown>
      const key = config.result_key
      const value = key ? body[key] : undefined
      setOutcome(`${config.result_prefix ?? ''}${value === undefined ? 'ok' : String(value)}`)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'plugin host unreachable')
    } finally {
      setPending(false)
    }
  }

  return (
    <Frame>
      <button
        type="button"
        onClick={() => void run()}
        disabled={pending || !config.plugin}
        className="self-start rounded border border-[#76B900]/40 bg-[#76B900]/10 px-2 py-1 text-[11px] text-[#a8e05f] hover:bg-[#76B900]/20 disabled:opacity-50 transition-colors"
      >
        {pending ? 'Working…' : (config.button ?? 'Run')}
      </button>
      {outcome && <p className="mt-1 text-[11px] text-zinc-300 tabular-nums">{outcome}</p>}
      {failure && <p className="mt-1 text-[11px] text-amber-300/90">{failure}</p>}
    </Frame>
  )
}

export function PluginEventsPanel({ panel }: { panel: DashboardPanel }) {
  const config = configOf(panel)
  const { result } = useBackend(config, config.path, config.refresh_s ?? 10)
  const line = describe(result)
  if (line) return <Notice>{line}</Notice>

  const data = (result as { data: Record<string, unknown> }).data
  const lines = (config.lines_key ? data[config.lines_key] : data) as unknown
  if (!Array.isArray(lines) || lines.length === 0) return <Notice>No events.</Notice>

  return (
    <Frame>
      <ul className="text-[11px] text-zinc-400 space-y-0.5 overflow-hidden">
        {lines.slice(-12).reverse().map((entry, index) => (
          <li key={index} className="truncate">{typeof entry === 'string' ? entry : JSON.stringify(entry)}</li>
        ))}
      </ul>
    </Frame>
  )
}
