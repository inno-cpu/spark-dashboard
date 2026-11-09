import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { pageSelection } from '@/lib/dashboard/selection'
import { engineKey } from '@/lib/identity'
import { engineSeries, type EngineSeriesName } from '@/lib/metricsHistoryStore'
import { NVIDIA_THEME } from '@/lib/theme'
import type { PanelContentProps } from '../panelRegistry'

interface HistorySpec {
  series: EngineSeriesName
  label: string
  unit: string
  yDomain?: [number, number]
}

const SPECS: Record<'tokens' | 'kv', HistorySpec> = {
  tokens: { series: 'tps', label: 'decode tok/s', unit: 'tok/s' },
  kv: { series: 'kvCache', label: 'kv cache', unit: '%', yDomain: [0, 100] },
}

const COLORS = [NVIDIA_THEME.healthy, '#60a5fa', '#eab308', '#f472b6']

/**
 * Engine history that follows the page target, like the Overview panels:
 * an explicit GPU/engine target shows that engine, "All models" (or no explicit
 * target) shows every engine. It carries no panel binding of its own — the page
 * control is the single place a target is chosen.
 */
export function RouterEngineHistoryPanel({
  panel,
  metric,
}: PanelContentProps & { metric: 'tokens' | 'kv' }) {
  const spec = SPECS[metric]
  const snapshot = useLatestSnapshot()
  const { chosen, source } = usePageSelection()
  const engines = snapshot?.engines ?? []
  const selection = pageSelection(snapshot, chosen, source)

  let targetEngine = null
  const explicitTarget = chosen.engineTarget
  if (explicitTarget?.kind === 'engine') {
    const endpoint = explicitTarget.endpoint
    targetEngine = engines.find((engine) => engine.endpoint === endpoint) ?? null
  } else if (chosen.gpuIndex != null) {
    targetEngine = engines.find((engine) => engine.gpu_indexes?.includes(chosen.gpuIndex ?? -1)) ?? null
  }
  const aggregate = chosen.engineTarget?.kind === 'all' || targetEngine === null
  void selection

  // Four fixed hooks: hook order must not depend on engine count or selection.
  const keys = aggregate
    ? [0, 1, 2, 3].map((index) => (engines[index] ? engineSeries(spec.series, engineKey(engines[index])) : ''))
    : [targetEngine ? engineSeries(spec.series, engineKey(targetEngine)) : '', '', '', '']
  const a = useMetricSeries(keys[0], panel.window)
  const b = useMetricSeries(keys[1], panel.window)
  const c = useMetricSeries(keys[2], panel.window)
  const d = useMetricSeries(keys[3], panel.window)
  const all = [a, b, c, d]

  const series = aggregate
    ? engines
        .slice(0, 4)
        .map((engine, index) => ({
          label: `gpu${engine.gpu_indexes?.[0] ?? index}`,
          color: COLORS[index % COLORS.length],
          data: all[index] ?? [],
        }))
        .filter((entry) => entry.data.length > 1)
    : [{
        label: `gpu${targetEngine?.gpu_indexes?.[0] ?? '?'}`,
        color: NVIDIA_THEME.healthy,
        data: all[0] ?? [],
      }].filter((entry) => entry.data.length > 1)

  if (series.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">
        {engines.length === 0 ? 'no engine running' : `collecting ${spec.label} samples…`}
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col px-1 py-1">
      <TimeSeriesChart series={series} unit={spec.unit} yDomain={spec.yDomain} />
    </div>
  )
}
