import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'

/**
 * Page target: which GPU the following panels show, and which engine.
 *
 * Exists because every panel on a page is already bound `follow`, yet the selection
 * plumbing had no control — so a page always sat on the host defaults. Picking a GPU
 * also picks the engine running there, because those are the two halves of the same
 * question on this host: one model per card.
 */
export function PageTargetSelector() {
  const snapshot = useLatestSnapshot()
  const { chosen, selectGpu, selectEngine } = usePageSelection()

  const gpus = snapshot?.gpus ?? []
  const engines = snapshot?.engines ?? []

  const current = chosen.engineTarget?.kind === 'all'
    ? 'all'
    : chosen.gpuIndex !== undefined && chosen.gpuIndex !== null
      ? `gpu:${chosen.gpuIndex}`
      : 'host'

  const choose = (value: string) => {
    if (value === 'host') {
      selectGpu(null)
      selectEngine(null)
      return
    }
    if (value === 'all') {
      selectGpu(null)
      selectEngine({ kind: 'all' })
      return
    }
    const index = Number(value.replace('gpu:', ''))
    if (!Number.isInteger(index)) return
    selectGpu(index)
    const engine = engines.find((entry) => entry.gpu_indexes?.includes(index))
    // No engine on that GPU is a legitimate answer; the engine panels then say so
    // rather than quietly showing another card's numbers.
    selectEngine(engine ? { kind: 'engine', endpoint: engine.endpoint } : null)
  }

  return (
    <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
      <span className="uppercase tracking-wide">target</span>
      <select
        aria-label="Page target"
        value={current}
        onChange={(event) => choose(event.target.value)}
        className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-[11px] text-zinc-200"
      >
        <option value="host">Follow host</option>
        {gpus.map((gpu, position) => {
          const index = gpu.index ?? position
          return <option key={index} value={`gpu:${index}`}>GPU {index}</option>
        })}
        <option value="all">All models</option>
      </select>
    </label>
  )
}
