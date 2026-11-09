import { useEffect, useState } from 'react'
import { HBar } from '@/components/gauges/HBar'
import { NVIDIA_THEME } from '@/lib/theme'

// Bars are scaled to this ceiling for every fan, so the columns are comparable.
const FAN_SCALE_RPM = 13000

interface FanRow {
  name: string
  rpm: number
}

interface ZoneRow {
  zone: string
  level_pct: number
}


/**
 * The chassis fans, from the IPMI tachometers Prometheus already scrapes.
 *
 * A passive GPU has no fan of its own — smfc drives the chassis zones — so this
 * is where "are the fans actually spinning" is answered. RPM is drawn against a
 * fixed 13000 ceiling so every column is comparable at a glance.
 */
export function FanTachPanel() {
  const [fans, setFans] = useState<FanRow[]>([])
  const [zones, setZones] = useState<ZoneRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/host/fans', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as { fans?: FanRow[]; zones?: ZoneRow[] }
        if (cancelled) return
        setFans(body.fans ?? [])
        setZones(body.zones ?? [])
        setError(null)
        setLoaded(true)
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

  if (error) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Fans — {error}</div>
  }
  if (!loaded) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">Reading fans…</div>
  }
  if (fans.length === 0) {
    return <div className="flex h-full items-center justify-center px-3 text-[11px] text-zinc-500">No fan tachometers reported.</div>
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1 px-1.5 py-1">
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-3 gap-y-[2px]">
        {fans.map((fan) => (
          <div key={fan.name} className="flex min-w-0 items-center gap-1.5">
            <span className="w-9 shrink-0 text-[10px] text-zinc-500">{fan.name}</span>
            <div className="min-w-0 flex-1">
              <HBar value={fan.rpm} max={FAN_SCALE_RPM} label="" unit="rpm" />
            </div>
          </div>
        ))}
      </div>
      {zones.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-[2px] text-[10px] text-zinc-500">
          {zones.map((zone) => (
            <span key={zone.zone}>
              zone {zone.zone} <span className="tabular-nums text-zinc-300">{zone.level_pct} %</span>
            </span>
          ))}
          <span style={{ color: NVIDIA_THEME.healthy }}>smfc driving</span>
        </div>
      )}
    </div>
  )
}
