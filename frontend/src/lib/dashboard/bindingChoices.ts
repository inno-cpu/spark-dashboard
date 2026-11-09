/**
 * What a panel can be pointed at, as a list an operator picks from.
 *
 * The mirror image of `bindings`: that module reads a binding and resolves it,
 * this one offers the ones a panel could have. Both obey the same prohibition —
 * **no silent substitution**. A panel pinned to a GPU or an engine that is not
 * on this host keeps its own option, marked absent and selected, because a
 * control that quietly showed a different target would repoint the panel the
 * moment anything else about it was edited.
 *
 * Pure, so the awkward cases — a pin to something absent, a binding that could
 * not be read, a binding of the wrong kind for the panel — are covered without
 * rendering anything.
 */

import { engineDescription } from '@/lib/format'
import {
  findEngineByEndpoint,
  findGpuByIndex,
  gpuIndexOf,
  type EngineIdentity,
  type GpuIdentity,
} from '@/lib/identity'
import type { GpuMetrics } from '@/types/metrics'
import { FOLLOW, UNREADABLE, type PanelBinding } from './bindings'
import type { PanelBindingKind } from './panels'

/** The value of the option a panel that follows its page carries. */
const FOLLOW_CHOICE = 'follow'

/**
 * The value shown for a binding that names nothing this panel can use. Offered
 * so the control has something to select — never a target to choose.
 */
const UNREADABLE_CHOICE = 'unreadable'

/** One thing a panel could be pointed at. */
export interface BindingChoice {
  /** Round-trips through `bindingFromChoice`; safe as an option value. */
  value: string
  label: string
  /** The target is not on this host — a pin left dangling, or a broken binding. */
  absent?: boolean
}

/** Everything the control needs: what to offer, and what is selected now. */
export interface BindingControl {
  value: string
  choices: BindingChoice[]
}

/** A GPU as the control names it. */
type GpuChoiceSource = GpuIdentity & Pick<GpuMetrics, 'name'>

/** A router backend as the control names it: the name the router reports. */
export interface BackendChoiceSource {
  name: string
}

/**
 * A binding that names a concrete target. Following and unreadable are the
 * other two states, and neither has a target to look up, label or keep — so
 * everything below takes this rather than re-asking which kind it has.
 */
type PinnedBinding = Extract<PanelBinding, { kind: 'gpu' } | { kind: 'engine' } | { kind: 'backend' }>

/**
 * The targets a panel of this binding kind can be pointed at, with the one it
 * currently holds selected.
 *
 * A panel that binds to nothing gets no choices — there is nothing on a
 * host-wide panel to pin, and offering a control that does nothing is worse
 * than offering none.
 */
export function bindingChoices(
  kind: PanelBindingKind,
  binding: PanelBinding,
  gpus: readonly GpuChoiceSource[],
  engines: readonly EngineIdentity[],
  backends: readonly BackendChoiceSource[] = [],
): BindingControl {
  if (kind === 'none') return { value: FOLLOW_CHOICE, choices: [] }

  const pinned = pinnedTarget(kind, binding)
  const readable = pinned !== null || binding.kind === 'follow'

  const choices: BindingChoice[] = [
    // The unreadable option leads, because it is what the panel is right now
    // and the operator's next move is to replace it.
    ...(readable ? [] : [unreadableChoice()]),
    { value: FOLLOW_CHOICE, label: followLabel(kind) },
    ...(kind === 'gpu'
      ? gpus.map(gpuChoice)
      : kind === 'backend'
        ? backends.map(backendChoice)
        : engines.map(engineChoice)),
  ]

  const value = pinned ? choiceOf(pinned) : readable ? FOLLOW_CHOICE : UNREADABLE_CHOICE
  const missing = pinned && !onThisHost(pinned, gpus, engines, backends) ? absentChoice(pinned) : null

  return { value, choices: missing ? [...choices, missing] : choices }
}

/**
 * The binding a chosen option means.
 *
 * Anything that is not one of the offered targets — the unreadable option
 * included — reads as unreadable rather than as a guess. The values come from
 * this module's own choices, so there is no legitimate third case.
 */
export function bindingFromChoice(value: string): PanelBinding {
  if (value === FOLLOW_CHOICE) return FOLLOW

  const separator = value.indexOf(':')
  const kind = value.slice(0, separator)
  const target = value.slice(separator + 1)
  if (target.length === 0) return UNREADABLE

  if (kind === 'gpu') {
    const index = Number(target)
    return Number.isInteger(index) && index >= 0 ? { kind: 'gpu', index } : UNREADABLE
  }

  if (kind === 'engine') return { kind: 'engine', endpoint: target }
  return kind === 'backend' ? { kind: 'backend', name: target } : UNREADABLE
}

/**
 * The panel's binding when it names a target this control could offer, null
 * otherwise — following, unreadable, or naming the wrong kind of target for
 * this panel, which is a corrupt document and reads the same way.
 */
function pinnedTarget(kind: 'gpu' | 'engine' | 'backend', binding: PanelBinding): PinnedBinding | null {
  if (kind === 'gpu' && binding.kind === 'gpu') return binding
  if (kind === 'engine' && binding.kind === 'engine') return binding
  if (kind === 'backend' && binding.kind === 'backend') return binding
  return null
}

function gpuChoice(gpu: GpuChoiceSource): BindingChoice {
  const pin = { kind: 'gpu', index: gpuIndexOf(gpu) } as const
  return { value: choiceOf(pin), label: `${pinLabel(pin)} — ${gpu.name}` }
}

function backendChoice(backend: BackendChoiceSource): BindingChoice {
  const pin = { kind: 'backend', name: backend.name } as const
  return { value: choiceOf(pin), label: backend.name }
}

function engineChoice(engine: EngineIdentity): BindingChoice {
  const pin = { kind: 'engine', endpoint: engine.endpoint } as const
  return { value: choiceOf(pin), label: engineDescription(engine) }
}

function unreadableChoice(): BindingChoice {
  return { value: UNREADABLE_CHOICE, label: 'Not readable — choose a target', absent: true }
}

/** The option kept for a target the host does not have, so the pin stays visible. */
function absentChoice(pin: PinnedBinding): BindingChoice {
  return { value: choiceOf(pin), label: `${pinLabel(pin)} (not on this host)`, absent: true }
}

function onThisHost(
  pin: PinnedBinding,
  gpus: readonly GpuChoiceSource[],
  engines: readonly EngineIdentity[],
  backends: readonly BackendChoiceSource[] = [],
): boolean {
  if (pin.kind === 'gpu') return findGpuByIndex(gpus, pin.index) !== undefined
  if (pin.kind === 'engine') return findEngineByEndpoint(engines, pin.endpoint) !== undefined
  return backends.some((backend) => backend.name === pin.name)
}

/** The one place a target becomes an option value, and the only grammar
 *  `bindingFromChoice` has to read back. */
function choiceOf(pin: PinnedBinding): string {
  if (pin.kind === 'gpu') return `gpu:${pin.index}`
  if (pin.kind === 'engine') return `engine:${pin.endpoint}`
  return `backend:${pin.name}`
}

/** How a target is named to the operator, on its own. */
function pinLabel(pin: PinnedBinding): string {
  if (pin.kind === 'gpu') return `GPU ${pin.index}`
  if (pin.kind === 'engine') return pin.endpoint
  return `backend ${pin.name}`
}

function followLabel(kind: 'gpu' | 'engine' | 'backend'): string {
  if (kind === 'gpu') return 'Follow the page’s GPU'
  if (kind === 'engine') return 'Follow the page’s engine'
  return 'Choose a backend'
}
