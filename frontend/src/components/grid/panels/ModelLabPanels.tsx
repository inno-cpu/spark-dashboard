import { useEffect, useRef, useState } from 'react'
import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { formatGpuName, formatGpuProfileLabel, formatProfileLabel } from '@/lib/modelIdentity'
import { NVIDIA_THEME } from '@/lib/theme'

interface Profile {
  profile?: string
  validated?: boolean
  external?: boolean
  managed?: boolean
  disabled?: boolean
  gpus?: number[]
  model_name?: string
  model_uid?: string
  max_model_len?: number
  speculative?: string
  drafter?: string
  notes?: string
}

interface Model {
  uid?: string
  model_name?: string
  context_length?: number
  model_engine?: string
  status?: string
  profile?: string
  gpu?: number | null
  gpu_index?: string | number
  gpu_uuid?: string
  gpu_indices?: number[]
  gpu_uuids?: string[]
  memory_bytes?: number
}

/** Validated profiles with a target GPU and a Load button. */
export function ModelProfilesPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [gpu, setGpu] = useState(1)
  const snapshot = useLatestSnapshot()
  const gpuChoices = (snapshot?.gpus ?? []).map((card) => card.index).filter((index): index is number => typeof index === 'number')
  const choices = gpuChoices.length > 0 ? gpuChoices : [0, 1, 2, 3]
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [occupied, setOccupied] = useState<Record<number, string>>({})
  const initialisedTarget = useRef(false)

  const load = async () => {
    try {
      const response = await fetch('/api/models/profiles', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { profiles?: Profile[] }
      setProfiles(body.profiles ?? [])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'unreachable')
    }
  }
  const loadOccupied = async () => {
    try {
      const response = await fetch('/api/models', { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const body = (await response.json()) as { models?: Model[] }
      const next: Record<number, string> = {}
      for (const model of body.models ?? []) {
        if (model.status !== 'READY') continue
        const many = model.gpu_indices
        if (Array.isArray(many) && many.length > 0) {
          for (const item of many) {
            if (Number.isFinite(Number(item))) next[Number(item)] = model.model_name ?? model.uid ?? 'model'
          }
          continue
        }
        const raw = model.gpu_index ?? model.gpu
        const index = typeof raw === 'string' ? Number(raw) : raw
        if (typeof index === 'number' && Number.isFinite(index)) {
          next[index] = model.model_name ?? model.uid ?? 'model'
        }
      }
      setOccupied(next)
      if (!initialisedTarget.current) {
        const free = choices.find((index) => next[index] === undefined)
        if (free !== undefined) setGpu(free)
        initialisedTarget.current = true
      }
    } catch {
      /* keep the last known occupancy */
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    void loadOccupied()
    const timer = setInterval(() => void loadOccupied(), 5000)
    return () => clearInterval(timer)
  }, [choices.join(',')])

  const launch = async (name: string) => {
    const profile = profiles.find((entry) => entry.profile === name)
    const multi = (profile?.gpus?.length ?? 0) > 1
    const target = multi ? `GPUs ${(profile?.gpus ?? []).join(',')}` : `GPU ${gpu}`
    const detail = profile
      ? `${profile.model_name ?? 'model'}`
      : name
    if (!window.confirm(`Load ${name} (${detail}) on ${target}?`)) return
    setBusy(name)
    try {
      const url = multi
        ? `/api/models/load?profile=${encodeURIComponent(name)}`
        : `/api/models/load?profile=${encodeURIComponent(name)}&gpu=${gpu}`
      const response = await fetch(url, { method: 'POST' })
      if (!response.ok) throw new Error(await response.text())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.slice(0, 120) : 'launch failed')
    } finally {
      setBusy(null)
      void load()
      void loadOccupied()
    }
  }

  if (error) return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">profiles — {error}</div>
  if (profiles.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no profiles installed</div>

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
        <span>load on</span>
        <select
          value={gpu}
          onChange={(event) => setGpu(Number(event.target.value))}
          className="rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[10px] text-zinc-200"
        >
          {choices.map((index) => (
            <option key={index} value={index}>
              {formatGpuName(index)}{occupied[index] ? ' (in use)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {profiles.map((profile) => (
          <div key={profile.profile} className="flex items-center gap-2 rounded border border-white/[0.06] px-1.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: NVIDIA_THEME.healthy }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-zinc-200">
                {formatProfileLabel(profile.profile)}
              </div>
              <div className="truncate text-[9px] text-zinc-500">
                {profile.managed ? '4-GPU managed · ' : profile.external ? 'external runtime · ' : ''}
                {profile.model_name} · {profile.speculative ?? 'no spec'} · drafter {(profile.drafter ?? '').split('/').pop() || '—'}
              </div>
            </div>
            <button
              type="button"
              disabled={profile.disabled === true || busy === profile.profile || (profile.external === true && !profile.managed) || ((profile.gpus?.length ?? 0) <= 1 && occupied[gpu] !== undefined)}
              title={profile.disabled ? 'Blocked: 128k prefill exceeded the 180 W limit; see validation notes' : profile.managed ? 'Managed four-GPU switch; starts GLM and restores the saved Qwen set on stop' : profile.external ? 'External runtime; not GPU-placeable' : occupied[gpu] ? `GPU ${gpu} already has ${occupied[gpu]}` : undefined}
              onClick={() => void launch(profile.profile ?? '')}
              className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:border-white/25 hover:text-zinc-200 disabled:opacity-40"
            >
              {profile.disabled ? 'blocked' : busy === profile.profile ? 'loading…' : profile.managed ? 'switch' : profile.external ? 'external' : occupied[gpu] ? 'gpu busy' : 'load'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Live models with identity, placement and unload. */
export function ModelInventoryPanel() {
  const [models, setModels] = useState<Model[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const response = await fetch('/api/models', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { models?: Model[] }
      setModels(body.models ?? [])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'unreachable')
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [])

  const unload = async (uid: string) => {
    if (!window.confirm(`Unload ${uid}?`)) return
    await fetch(`/api/models/unload?uid=${encodeURIComponent(uid)}`, { method: 'POST' }).catch(() => undefined)
    void load()
  }

  if (error) return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">models — {error}</div>
  if (models.length === 0) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">no models loaded</div>

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      {models.map((model) => (
        <div key={model.uid} className="flex items-center gap-2 rounded border border-white/[0.06] px-1.5 py-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: model.status === 'READY' ? NVIDIA_THEME.healthy : NVIDIA_THEME.warning }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-zinc-200">
              {formatGpuProfileLabel(
                model.gpu_index ?? model.gpu,
                model.profile ?? model.model_name,
              )}
            </div>
            <div className="truncate text-[9px] text-zinc-500">
              {model.model_name ?? model.uid ?? 'unknown model'} · {model.model_engine ?? 'engine n/a'} · {model.gpu_indices?.length ? `GPUs ${model.gpu_indices.join(',')}` : model.memory_bytes ? `${(model.memory_bytes / 1024 ** 3).toFixed(0)} GiB` : 'memory n/a'}
            </div>
          </div>
          <span className="shrink-0 text-[9px] text-zinc-500">{model.status ?? '?'}</span>
          <button
              type="button"
              onClick={() => void unload(model.uid ?? '')}
              className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
            >
              unload
          </button>
        </div>
      ))}
    </div>
  )
}
