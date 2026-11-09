import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { NVIDIA_THEME } from '@/lib/theme'

interface Zone {
  zone: string
  level_pct: number
  temperature_c: number | null
}

interface CurveBody {
  curve: Array<[number, number]>
  live: { temperature_c: number | null; level_pct: number | null }
}

interface CoolingBody {
  smfc_up: boolean
  control_held: boolean | null
  zones: Zone[]
}

/**
 * smfc's own view of the chassis: whether it is up, whether it still holds the
 * fans, and what each zone is doing — the arbitration that decides fan duty.
 * None of this is in NVML, so it does not belong on a GPU card.
 */
export function CoolingStatusPanel() {
  const [body, setBody] = useState<CoolingBody | null>(null)
  const [curve, setCurve] = useState<CurveBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/host/cooling', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as CoolingBody
        if (!cancelled) {
          setBody(payload)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'unreachable')
      }
    }
    void load()
    const loadCurve = async () => {
      try {
        const response = await fetch('/api/host/fan-curve', { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const payload = (await response.json()) as CurveBody
        if (!cancelled) setCurve(payload)
      } catch {
        /* the plot is optional decoration around the smfc state */
      }
    }
    void loadCurve()
    const curveTimer = setInterval(() => void loadCurve(), 5000)
    const timer = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
      clearInterval(curveTimer)
    }
  }, [])

  if (error) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">smfc — {error}</div>
  if (!body) return <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">Reading smfc…</div>

  const held = body.control_held === true
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: body.smfc_up ? NVIDIA_THEME.healthy : NVIDIA_THEME.critical }}
        />
        <span className="text-zinc-300">{body.smfc_up ? 'smfc up' : 'smfc down'}</span>
        <span className="ml-auto text-[10px] text-zinc-500">
          fan control {body.control_held === null ? 'unknown' : held ? 'held' : 'not held'}
        </span>
      </div>
      {curve && curve.curve.length >= 2 && (
        <div className="flex flex-wrap items-center gap-x-3 text-[10px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-[2px] w-4" style={{ background: NVIDIA_THEME.healthy }} />
            configured curve
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: NVIDIA_THEME.warning }} />
            live point
          </span>
        </div>
      )}
      {curve && curve.curve.length >= 2 && (
        <div style={{ height: 120 }} className="w-full">
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={curve.curve.map(([temperature, level]) => ({ temperature, level }))} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="temperature" type="number" domain={['dataMin', 'dataMax']} tick={{ fill: '#71717a', fontSize: 9 }} />
              <YAxis domain={[0, 100]} width={26} tick={{ fill: '#71717a', fontSize: 9 }} />
              <Tooltip
                contentStyle={{ background: '#0d0d10', border: '1px solid rgba(255,255,255,0.08)', fontSize: 10 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const point = payload[0]?.payload as { temperature?: number; level?: number } | undefined
                  if (!point) return null
                  return (
                    <div className="rounded border border-white/10 bg-[#0d0d10] px-2 py-1 text-[10px] text-zinc-300">
                      <div className="tabular-nums">
                        {point.temperature} °C → {point.level} % duty
                      </div>
                    </div>
                  )
                }}
              />
              <Line type="monotone" dataKey="level" stroke={NVIDIA_THEME.healthy} dot={false} strokeWidth={1.6} isAnimationActive={false} />
              {curve.live.temperature_c !== null && curve.live.level_pct !== null && (
                <ReferenceDot
                  x={curve.live.temperature_c}
                  y={curve.live.level_pct}
                  r={3}
                  fill={NVIDIA_THEME.warning}
                  stroke="none"
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
        {body.zones.map((zone) => (
          <span key={zone.zone}>
            zone {zone.zone}{' '}
            <span className="tabular-nums text-zinc-300">
              {zone.level_pct} %{zone.temperature_c === null ? '' : ` · ${zone.temperature_c.toFixed(1)} °C`}
            </span>
          </span>
        ))}
        {curve?.live.temperature_c !== null && curve?.live.level_pct !== null && curve?.live && (
          <span>
            live{' '}
            <span className="tabular-nums text-amber-300/90">
              {curve.live.temperature_c.toFixed(1)} °C → {curve.live.level_pct} %
            </span>
          </span>
        )}
      </div>
    </div>
  )
}
