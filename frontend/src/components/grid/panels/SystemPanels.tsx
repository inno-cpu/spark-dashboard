import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NVIDIA_THEME } from '@/lib/theme'

interface Service { id?: string; name?: string; ok?: boolean; link?: string; version?: string | null }
interface Endpoint { name?: string; addr?: string; scope?: string; ok?: boolean; url?: string | null }

function useJson<T>(path: string, intervalMs = 10000): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(path, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as T
        if (!cancelled) {
          setData(body)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'unreachable')
      }
    }
    void load()
    const timer = setInterval(() => void load(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [path, intervalMs])
  return { data, error }
}

const tone = (ok: boolean) => (ok ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical)
const Dot = ({ ok }: { ok: boolean }) => (
  <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone(ok) }} />
)
const Badge = ({ ok, label }: { ok: boolean; label?: string }) => (
  <span
    className="rounded px-1 py-0.5 text-[9px] font-semibold tracking-wide"
    style={{ color: tone(ok), background: ok ? 'rgba(118,185,0,0.12)' : 'rgba(239,68,68,0.12)' }}
  >
    {label ?? (ok ? 'HEALTHY' : 'DOWN')}
  </span>
)

/** Each external dependency as a card: badge, version, and a link to its dashboard. */
export function ServiceHealthPanel() {
  const { data, error } = useJson<{ services?: Service[] }>('/api/services')
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">services — {error}</div>
  const services = data?.services ?? []
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-1 overflow-y-auto px-1.5 py-1.5">
      {services.map((service) => {
        const origin = typeof window === 'undefined' ? '' : window.location.origin
        const href = service.link || (service.id === 'spark' || service.id === 'caddy' ? origin : '')
        return (
        <a
          key={service.id}
          href={href || undefined}
          target={href ? '_blank' : undefined}
          rel="noreferrer"
          className="flex flex-col justify-center gap-0.5 rounded border border-white/[0.06] px-2 py-1 hover:border-white/20"
        >
          <div className="flex items-center gap-1.5">
            <Dot ok={Boolean(service.ok)} />
            <span className="truncate text-[11px] text-zinc-200">{service.name}</span>
            <span className="ml-auto"><Badge ok={Boolean(service.ok)} /></span>
          </div>
          <div className="flex items-baseline justify-between text-[9px] text-zinc-500">
            <span className="truncate">{service.version ?? 'no version'}</span>
            <span className="text-zinc-600">{href ? 'open ↗' : 'no reachable url'}</span>
          </div>
        </a>
        )
      })}
    </div>
  )
}

/** Reachable services link; loopback-only ones say so rather than pointing at the browser. */
export function EndpointsPanel() {
  const { data, error } = useJson<{ endpoints?: Endpoint[] }>('/api/endpoints')
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">endpoints — {error}</div>
  const rows = data?.endpoints ?? []
  // Reachable target comes from the server; the bind address is what the process
  // listens on, not something a browser can use.
  const href = (row: Endpoint): string | null => row.url ?? null
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-0.5 px-2 py-1.5">
      {rows.map((row) => {
        const link = href(row)
        return (
          <div key={row.addr} className="flex items-baseline gap-2 text-[10px]">
            <Dot ok={Boolean(row.ok)} />
            <span className="w-32 shrink-0 truncate text-zinc-300">{row.name}</span>
            {link ? (
              <a href={link} target="_blank" rel="noreferrer" className="font-mono text-emerald-400 hover:underline">
                {row.addr}
              </a>
            ) : (
              <span className="font-mono text-zinc-400" title="loopback only — not reachable from a browser">{row.addr}</span>
            )}
            <span className="ml-auto shrink-0 text-zinc-600">{row.scope}</span>
            {link ? <span className="shrink-0 text-emerald-500">↗</span> : null}
          </div>
        )
      })}
    </div>
  )
}

export function ClientAccessPanel() {
  const { data, error } = useJson<Record<string, string | null>>('/api/access', 30000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">access — {error}</div>
  if (!data) return null
  const linkRow = (label: string, value: string | null | undefined) => (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="w-28 shrink-0 text-zinc-500">{label}</span>
      {value ? (
        <a href={value} target="_blank" rel="noreferrer" className="truncate font-mono text-emerald-400 hover:underline">{value}</a>
      ) : <span className="text-zinc-600">—</span>}
    </div>
  )
  const tokenRow = (label: string, value: string | null | undefined) => (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="w-28 shrink-0 text-zinc-500">{label}</span>
      <span className="select-all truncate font-mono text-zinc-200">{value ?? '—'}</span>
    </div>
  )
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-0.5 px-2 py-1.5">
      {tokenRow('client token', data.client_token)}
      {tokenRow('engine key', data.engine_key)}
      {tokenRow('API (LAN)', data.api_base_lan)}
      {tokenRow('API (tailnet)', data.api_base_tailnet)}
      {linkRow('dashboard', origin)}
      {linkRow('setup script', data.setup_url)}
      {linkRow('CA cert', data.ca_url)}
      <div className="truncate text-[9px] text-zinc-600">{data.ca_path}</div>
    </div>
  )
}

export function EngineKeyPanel() {
  const { data, error } = useJson<{ key?: string; sha256?: string; path?: string }>('/api/engine-key', 30000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">key — {error}</div>
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-1 px-2 py-1.5">
      <div className="select-all break-all font-mono text-[12px] text-zinc-100">{data?.key ?? '—'}</div>
      <div className="text-[9px] text-zinc-500">{data?.path}</div>
      <div className="truncate font-mono text-[9px] text-zinc-600">sha256 {data?.sha256 ?? 'n/a'}</div>
    </div>
  )
}

export function GatewayConfigPanel() {
  const { data, error } = useJson<{ config?: Record<string, unknown>; sha256?: string }>('/api/gateway-config', 30000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">gateway — {error}</div>
  const config = data?.config ?? {}
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-0.5 px-2 py-1.5">
      {Object.entries(config).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2 text-[10px]">
          <span className="w-32 shrink-0 truncate text-zinc-500">{key}</span>
          <span className="truncate tabular-nums text-zinc-200">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
        </div>
      ))}
      <div className="truncate font-mono text-[9px] text-zinc-600">sha256 {data?.sha256 ?? 'n/a'}</div>
    </div>
  )
}

export function GatewayRequestsPanel() {
  const { data, error } = useJson<{ requests?: Array<Record<string, unknown>> }>('/api/gateway-requests')
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">requests — {error}</div>
  const rows = data?.requests ?? []
  if (rows.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no gateway requests logged</div>
  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-1">
      {rows.map((row, index) => {
        // No link: the gateway is TLS with an internal CA, and the request log is
        // evidence, not navigation.
        const href = undefined
        return (
          <div key={index} className="flex items-baseline gap-2 font-mono text-[9px] text-zinc-400">
            <span className="w-20 shrink-0 truncate text-zinc-600">{String(row.time ?? '').slice(5, 19)}</span>
            <span className={Number(row.status) >= 400 ? 'text-red-400' : 'text-emerald-400'}>{String(row.status ?? '')}</span>
            <span className="w-10 shrink-0">{String(row.method ?? '')}</span>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="truncate hover:underline">{String(row.uri)}</a>
            ) : <span className="truncate">{String(row.uri ?? '')}</span>}
            <span className="ml-auto">{row.duration_ms == null ? '' : `${row.duration_ms} ms`}</span>
          </div>
        )
      })}
    </div>
  )
}

interface ProtectionBody {
  guard?: { active?: boolean; heartbeat_age_s?: number | null; latch?: boolean }
  c80?: { marker?: boolean; last_line?: string | null }
  units?: Array<{ unit?: string; name?: string; active?: string; enabled?: string }>
}

/** Safety chain: latch, guard heartbeat, C80 marker, units. Read-only; the chain does
 *  not depend on the dashboard being open, and this panel does not pretend to arm it. */
export function SafetyStatusPanel() {
  const { data, error } = useJson<ProtectionBody>('/api/host/protection', 5000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">safety — {error}</div>
  const guard = data?.guard
  const units = data?.units ?? []
  const latched = Boolean(guard?.latch)
  const row = (ok: boolean, label: string, detail: string) => (
    <div className="flex items-baseline gap-2 text-[10px]">
      <Dot ok={ok} />
      <span className="w-36 shrink-0 text-zinc-300">{label}</span>
      <span className="truncate text-zinc-500">{detail}</span>
    </div>
  )
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-0.5 px-2 py-1.5">
      {row(!latched, 'thermal latch', latched ? 'LATCHED — inference blocked' : 'clear')}
      {row(guard?.heartbeat_age_s != null && guard.heartbeat_age_s < 15, 'guard heartbeat', guard?.heartbeat_age_s == null ? 'no heartbeat file' : `${guard.heartbeat_age_s.toFixed(1)} s ago (fresh < 15 s)`)}
      {row(true, 'C.80 restored marker', data?.c80?.marker ? 'present — fan curve was restored' : 'absent — normal until C.80 restores a curve')}
      {units.map((unit) => row(unit.active === 'active', unit.unit ?? unit.name ?? 'unit', `active=${unit.active ?? '?'} enabled=${unit.enabled ?? '?'}`))}
      <a href="/pages/cooling" className="mt-1 text-[10px] text-emerald-400 hover:underline">Cooling page →</a>
    </div>
  )
}


interface RouterDefaults {
  enabled?: boolean
  reasoning_effort?: string
  enable_thinking?: boolean
  max_tokens?: number | null
  force_max_tokens?: boolean
  temperature?: number | null
  top_p?: number | null
  updated_at?: string | null
  updated_by?: string | null
}

/** Router request defaults, editable. The router validates and persists them; this
 *  card never claims a value it did not read back. */
export function RouterDefaultsPanel() {
  const { data, error } = useJson<{ config?: RouterDefaults; path?: string }>('/api/router/defaults', 15000)
  const [draft, setDraft] = useState<RouterDefaults | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data?.config && !draft) setDraft(data.config)
  }, [data, draft])

  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">router defaults — {error}</div>
  if (!draft) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">reading router defaults…</div>

  const set = (patch: Partial<RouterDefaults>) => setDraft({ ...draft, ...patch })
  const save = async () => {
    if (!window.confirm('Apply these request defaults to every new request?')) return
    setSaving(true)
    setStatus(null)
    try {
      const response = await fetch('/api/router/defaults', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      if (!response.ok) throw new Error((await response.text()).slice(0, 120))
      setStatus('saved')
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  const row = (label: string, control: ReactNode) => (
    <div className="flex items-center gap-2 text-[9px] leading-tight">
      <span className="w-28 shrink-0 text-zinc-500">{label}</span>
      {control}
    </div>
  )
  const numberOrNull = (value: string): number | null => (value.trim() === '' ? null : Number(value))

  return (
    <div className="flex h-full min-h-0 flex-col gap-0.5 overflow-y-auto px-2 py-1">
      {row('enabled', <input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => set({ enabled: e.target.checked })} />)}
      {row('reasoning effort', (
        <select value={draft.reasoning_effort ?? 'low'} onChange={(e) => set({ reasoning_effort: e.target.value })}
                className="rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[10px]">
          {['low', 'medium', 'high', 'xhigh'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      ))}
      {row('thinking', <input type="checkbox" checked={Boolean(draft.enable_thinking)} onChange={(e) => set({ enable_thinking: e.target.checked })} />)}
      {row('max tokens', (
        <input type="number" min={1} max={524288} value={draft.max_tokens ?? ''} placeholder="unset"
               onChange={(e) => set({ max_tokens: e.target.value === '' ? null : Number(e.target.value) })}
               className="w-24 rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[10px]" />
      ))}
      {row('force max tokens', <input type="checkbox" checked={Boolean(draft.force_max_tokens)} onChange={(e) => set({ force_max_tokens: e.target.checked })} />)}
      {row('temperature', (
        <input type="number" step="0.1" min={0} max={2} value={draft.temperature ?? ''}
               placeholder="unset"
               onChange={(e) => set({ temperature: numberOrNull(e.target.value) })}
               className="w-20 rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[10px]" />
      ))}
      {row('top_p', (
        <input type="number" step="0.05" min={0} max={1} value={draft.top_p ?? ''}
               placeholder="unset"
               onChange={(e) => set({ top_p: numberOrNull(e.target.value) })}
               className="w-20 rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[10px]" />
      ))}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={saving}
                className="rounded border border-[#76B900]/50 px-2 py-0.5 text-[10px] text-[#76B900] hover:bg-[#76B900]/10 disabled:opacity-40">
          {saving ? 'saving…' : 'save'}
        </button>
        <span className="truncate text-[9px] text-zinc-500">
          {status ?? `updated ${draft.updated_at ?? 'never'} by ${draft.updated_by ?? 'nobody'}`}
        </span>
      </div>
      <div className="truncate font-mono text-[9px] text-zinc-600">{data?.path}</div>
    </div>
  )
}


interface NetdataAlarm {
  id?: string
  name?: string
  chart?: string
  status?: string
  summary?: string
  info?: string
  when?: number
  value?: number | string
  units?: string
}

/** Netdata's own alarm engine: active CRITICAL/WARNING alarms, newest first. */
export function NetdataAlarmsPanel() {
  const { data, error } = useJson<{ alarms?: NetdataAlarm[] }>('/api/netdata/alarms', 15000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">netdata alarms — {error}</div>
  const alarms = data?.alarms ?? []
  if (alarms.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no active Netdata alarms</div>
  const colour = (status?: string) =>
    status === 'CRITICAL' ? NVIDIA_THEME.critical : status === 'WARNING' ? NVIDIA_THEME.warning : NVIDIA_THEME.healthy
  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-1">
      {alarms.map((alarm) => (
        <div key={alarm.id} className="flex items-baseline gap-2 border-t border-white/[0.04] py-0.5 text-[10px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colour(alarm.status) }} />
          <span className="w-16 shrink-0" style={{ color: colour(alarm.status) }}>{alarm.status ?? '?'}</span>
          <span className="w-40 shrink-0 truncate text-zinc-200">{alarm.name ?? alarm.id}</span>
          <span className="truncate text-zinc-500">{alarm.summary ?? alarm.info ?? alarm.chart ?? ''}</span>
          <span className="ml-auto shrink-0 text-[9px] text-zinc-600">
            {alarm.when ? new Date(alarm.when * 1000).toLocaleTimeString([], { hour12: false }) : ''}
          </span>
        </div>
      ))}
    </div>
  )
}


interface OwnershipRow {
  gpu_uuid?: string
  gpu_index?: number | string | null
  pid?: number | null
  process?: string
  used_mib?: number | null
  model_uid?: string | null
  model_name?: string | null
}

/** Which process/model actually holds each GPU, from nvidia-smi + bridge. */
export function OwnershipPanel() {
  const { data, error } = useJson<{ rows?: OwnershipRow[] }>('/api/host/ownership', 10000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">ownership — {error}</div>
  const rows = data?.rows ?? []
  if (rows.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no compute processes</div>
  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-1">
      <div className="flex gap-2 pb-0.5 text-[9px] uppercase tracking-wide text-zinc-600">
        <span className="w-8 shrink-0">gpu</span>
        <span className="w-20 shrink-0">model</span>
        <span className="w-14 shrink-0 text-right">pid</span>
        <span className="w-20 shrink-0 text-right">used</span>
        <span className="truncate">process</span>
      </div>
      {rows.map((row, index) => (
        <div key={`${row.gpu_uuid}-${row.pid}-${index}`} className="flex items-baseline gap-2 border-t border-white/[0.04] py-0.5 text-[9px]">
          <span className="w-8 shrink-0 text-zinc-400">{row.gpu_index ?? '—'}</span>
          <span className="w-20 shrink-0 truncate text-zinc-200">{row.model_name ?? row.model_uid ?? 'unassigned'}</span>
          <span className="w-14 shrink-0 text-right tabular-nums text-zinc-500">{row.pid ?? '—'}</span>
          <span className="w-20 shrink-0 text-right tabular-nums text-zinc-400">{row.used_mib == null ? '—' : `${row.used_mib.toLocaleString()} MiB`}</span>
          <span className="truncate text-zinc-600">{row.process ?? ''}</span>
        </div>
      ))}
    </div>
  )
}

interface AuditEntry {
  ts?: number | string
  action?: string
  actor?: string
  detail?: unknown
  config?: unknown
  raw?: string
}

export function AuditLogPanel() {
  const { data, error } = useJson<{ entries?: AuditEntry[] }>('/api/audit', 15000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">audit — {error}</div>
  const entries = data?.entries ?? []
  if (entries.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no audit entries yet</div>
  const when = (ts?: number | string) => {
    if (typeof ts === 'number') return new Date(ts * 1000).toLocaleTimeString([], { hour12: false })
    if (typeof ts === 'string') return ts.replace('T', ' ').replace('Z', '').slice(0, 19)
    return '—'
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 py-1 font-mono text-[9px]">
      {entries.map((entry, index) => (
        <div key={index} className="flex gap-2 border-t border-white/[0.04] py-0.5">
          <span className="w-32 shrink-0 text-zinc-600">{when(entry.ts)}</span>
          <span className="w-24 shrink-0 text-zinc-300">{entry.action ?? '—'}</span>
          <span className="truncate text-zinc-500">{entry.raw ?? JSON.stringify(entry.config ?? entry.detail ?? '')}</span>
        </div>
      ))}
    </div>
  )
}

export function JournalTailPanel() {
  const [unit, setUnit] = useState('xinference')
  const { data, error } = useJson<{ lines?: string[] }>(`/api/journal?unit=${unit}`, 10000)
  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">journal — {error}</div>
  const lines = (data?.lines ?? []).slice(-40)
  return (
    <div className="flex h-full min-h-0 flex-col px-2 py-1">
      <div className="flex justify-end pb-0.5">
        <select value={unit} onChange={(event) => setUnit(event.target.value)}
                className="rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[9px]">
          {['xinference', 'hyperqwen-router', 'spark-dashboard', 'caddy', 'smfc'].map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[9px] text-zinc-500">
        {lines.length === 0 ? <div className="text-center text-[11px] text-zinc-500">no log lines</div> : lines.map((line, index) => (
          <div key={index} className="truncate border-t border-white/[0.03] py-0.5">{line}</div>
        ))}
      </div>
    </div>
  )
}
