/**
 * Every panel the dashboard can put on a page, and what each one binds to.
 *
 * The granularity is deliberate: one panel per metric rather than a handful of
 * fixed composite cards, so an operator watching a training run can give GPU
 * temperature and power the whole screen and drop the network and disk panels
 * entirely. It is the reason the configuration is a versioned schema with a
 * migration obligation — a closed panel set with opaque geometry was considered
 * and rejected.
 *
 * **The ids are persisted.** They appear verbatim in saved documents, so
 * renaming one is a breaking change that needs a migration, not a refactor.
 * Adding one is additive and needs none.
 */

import type { MetricGroup } from '@/types/metrics'
import type { PanelSize } from './grid'

/** What a panel needs pointed at it before it can show anything. */
export type PanelBindingKind =
  /** One GPU, identified by its integer index. */
  | 'gpu'
  /** One inference engine, identified by its endpoint. */
  | 'engine'
  /** One router backend, identified by the name the router reports. */
  | 'backend'
  /** Nothing — the panel covers the whole host, or every engine at once. */
  | 'none'

/** What the dashboard knows about a panel type before any document is read. */
export interface PanelTypeSpec {
  /** What has to be bound for the panel to render data. */
  binds: PanelBindingKind
  /** Title shown when the operator has not renamed the panel. */
  title: string
  /**
   * Size the palette places the panel at, when the standard one is wrong for
   * it. Only a starting point — the operator drags and resizes from there — so
   * a type only declares this when the standard size would land it unreadable.
   */
  size?: PanelSize
  /**
   * Whether the panel's rendering covers the time window it carries. Absent
   * means it does, which is true of every panel that charts a series; a type
   * declares `false` when its window would be a control that changes nothing.
   */
  windowed?: boolean
  /**
   * The metric groups the panel shows (ADR-0004). Bound to an engine that
   * reports none of them, the panel keeps its slot and says so; reporting only
   * some, it omits the parts that are missing. Absent on a panel that shows no
   * engine metrics — the engine's identity, its logs, its request timeline.
   */
  metricGroups?: readonly MetricGroup[]
}

/**
 * What a panel is added at: a quarter of the grid's width and a bit under half
 * its height, so four sit in a row and the page still tiles.
 */
export const DEFAULT_PANEL_SIZE: PanelSize = { w: 3, h: 3 }

/**
 * The vocabulary. Declaration order is palette order, so related panels sit
 * together where an operator goes looking for them.
 */
export const PANEL_TYPES = {
  // ── Per-GPU hardware ────────────────────────────────────────────────────
  // A whole card for one GPU: the composite an operator puts four of on a page.
  // Binds like every other hardware panel, so the native Source selector points
  // it at a card and a template can bind it too.
  'gpu-overview': { binds: 'gpu', title: 'GPU Overview', windowed: false },
  // Temperature, fan and power for one card: the cooling question, not the
  // utilisation question.
  'gpu-cooling': { binds: 'gpu', title: 'GPU Cooling', windowed: false },

  // ── Host cooling and protection ─────────────────────────────────────────
  // Data the GPU collector cannot see: the IPMI fan tachometers and the thermal
  // guard's latch. Served by this dashboard, not by a plugin.
  'fan-tach': { binds: 'none', title: 'Fan Tachometer', windowed: false },
  'protection-status': { binds: 'none', title: 'Protection', windowed: false },
  'c80-watchdog': { binds: 'none', title: 'C.80 Watchdog', windowed: false },
  'thermal-guard': { binds: 'none', title: 'Thermal Guard', windowed: false },

  // ── Routing ─────────────────────────────────────────────────────────────
  // The router is read-only here: it owns routing, this shows its state.
  'router-backends': { binds: 'none', title: 'Router Backends', windowed: false },
  'router-traffic': { binds: 'none', title: 'Router Traffic', windowed: false },
  // One backend per panel, pinned through the native Source selector.
  // `binds: 'backend'` is what makes that control offer router backends.
  'router-backend': { binds: 'backend', title: 'Router Backend', windowed: false },
  'router-summary': { binds: 'none', title: 'Router Summary', windowed: false },
  // Follows the page target (GPU or all models); no panel binding of its own.
  'router-tokens': { binds: 'none', title: 'Decode Throughput', windowed: true },
  'router-kv': { binds: 'none', title: 'KV Cache Usage', windowed: true },
  'model-inventory': { binds: 'none', title: 'Loaded Models', windowed: false },
  'model-profiles': { binds: 'none', title: 'Model Profiles', windowed: false },
  // Every GPU at once; binds nothing because it is not about one card.
  'gpu-fleet': { binds: 'none', title: 'GPU Fleet', windowed: false },
  'service-health': { binds: 'none', title: 'Service Health', windowed: false },
  'endpoints': { binds: 'none', title: 'Endpoints', windowed: false },
  'client-access': { binds: 'none', title: 'Client Access', windowed: false },
  'engine-key': { binds: 'none', title: 'Engine Key', windowed: false },
  'gateway-config': { binds: 'none', title: 'Gateway Config', windowed: false },
  'gateway-requests': { binds: 'none', title: 'API Requests', windowed: false },
  'safety-status': { binds: 'none', title: 'Safety Status', windowed: false },
  'router-defaults': { binds: 'none', title: 'Router Defaults', windowed: false },
  'router-messages': { binds: 'none', title: 'Router Messages', windowed: false },
  'netdata-alarms': { binds: 'none', title: 'Netdata Alarms', windowed: false },
  'host-ownership': { binds: 'none', title: 'GPU Ownership', windowed: false },
  'audit-log': { binds: 'none', title: 'Change Audit', windowed: false },
  'journal-tail': { binds: 'none', title: 'Unit Journal', windowed: false },
  // Cooling facts NVML does not carry: smfc zone arbitration and the HBM/fan
  // sensors Netdata publishes.
  'cooling-status': { binds: 'none', title: 'Cooling Status', windowed: false },
  'cooling-summary': { binds: 'none', title: 'Cooling Summary', windowed: false },
  'fan-duty': { binds: 'none', title: 'Fan Duty', windowed: false },
  'hbm-history': { binds: 'none', title: 'HBM Temperature', windowed: true },
  'fan-history': { binds: 'none', title: 'Fan History', windowed: true },
  'chassis-temp': { binds: 'none', title: 'Chassis Temperature', windowed: true },
  'gpu-power-history': { binds: 'none', title: 'GPU Power History', windowed: true },
  'duty-history': { binds: 'none', title: 'Fan Duty History', windowed: true },
  'inlet-history': { binds: 'none', title: 'Inlet History', windowed: true },


  'gpu-utilization': { binds: 'gpu', title: 'GPU Utilization' },
  'gpu-temperature': { binds: 'gpu', title: 'GPU Temp' },
  'gpu-power': { binds: 'gpu', title: 'GPU Power' },
  'gpu-clock': { binds: 'gpu', title: 'GPU Clock' },
  'gpu-memory': { binds: 'gpu', title: 'GPU Memory' },
  'gpu-fan': { binds: 'gpu', title: 'GPU Fan' },
  // Bus traffic per card: the disk/network I/O shape, bound to a GPU. Absent
  // on the unified-memory SoCs, where there is no link to report.
  'gpu-pcie': { binds: 'gpu', title: 'GPU PCIe' },
  // A discrete list rather than a series — but still windowed, unlike `logs`
  // below: the history store keeps a bounded ring of events and filters it by
  // the window, so choosing 15m over 5m genuinely shows the operator more.
  'gpu-events': { binds: 'gpu', title: 'GPU Events' },

  // ── Host-wide hardware ──────────────────────────────────────────────────
  'cpu-utilization': { binds: 'none', title: 'CPU' },
  'cpu-cores': { binds: 'none', title: 'CPU Cores' },
  // Unified-memory hosts report one pool shared with the GPU, so this is a
  // host-wide panel rather than a per-GPU one.
  memory: { binds: 'none', title: 'Memory' },
  'disk-io': { binds: 'none', title: 'Disk I/O' },
  'network-io': { binds: 'none', title: 'Network' },

  // ── Engines ─────────────────────────────────────────────────────────────
  // The only engine panel that binds to nothing: it is about the host, not
  // about one target.
  'engines-overview': { binds: 'none', title: 'All Engines' },
  'engine-status': { binds: 'engine', title: 'Engine' },
  'engine-prefill-throughput': {
    binds: 'engine',
    title: 'Prefill Throughput',
    metricGroups: ['Throughput', 'TtftMean'],
  },
  'engine-decode-throughput': {
    binds: 'engine',
    title: 'Decode Throughput',
    metricGroups: ['Throughput', 'TpotMean'],
  },
  // `BatchSize` is deliberately left out: its tile is shown here, but tokens
  // per engine step is not a latency, so an engine reporting no latency group
  // gets the placeholder, batch size or not.
  'engine-latency': {
    binds: 'engine',
    title: 'Latency',
    metricGroups: [
      'TtftMean',
      'TtftPercentiles',
      'E2eMean',
      'E2ePercentiles',
      'ItlMean',
      'ItlPercentiles',
      'TpotMean',
      'TpotPercentiles',
      'QueueTime',
    ],
  },
  // Goodput is read off the latency histograms, which are what an engine
  // reporting percentiles has and one reporting only means does not.
  'engine-slo-goodput': {
    binds: 'engine',
    title: 'SLO Goodput',
    metricGroups: ['TtftPercentiles', 'E2ePercentiles', 'ItlPercentiles', 'TpotPercentiles'],
  },
  'engine-requests': {
    binds: 'engine',
    title: 'Requests',
    metricGroups: ['ActiveRequests', 'RequestTotal', 'Preemptions'],
  },
  'engine-cache': { binds: 'engine', title: 'Cache', metricGroups: ['KvCache', 'PrefixCache'] },
  'engine-spec-decode': {
    binds: 'engine',
    title: 'Speculative Decoding',
    metricGroups: ['SpeculativeDecoding'],
  },
  // Windowed for the same reason as `gpu-events`, and it needs the window
  // twice over: the requests are filtered by it, and the timeline draws each
  // one against it as the axis it is positioned on.
  'inference-timeline': { binds: 'engine', title: 'Inference Requests' },
  // The log socket addresses an engine by endpoint, so logs bind like any
  // other engine panel instead of being a fixed drawer. A line of container
  // output is long, and a tail has no window to cover.
  logs: { binds: 'engine', title: 'Logs', size: { w: 6, h: 4 }, windowed: false },

  // ── Generic plugin panels ───────────────────────────────────────────────
  // Built into the host once, configured by a plugin template through the
  // panel's `config`: no per-plugin React component, and nothing here knows
  // what any particular plugin is for. They bind to nothing themselves — the
  // config names the plugin whose backend they talk to.
  'plugin-status': { binds: 'none', title: 'Plugin Status', windowed: false },
  'plugin-metric': { binds: 'none', title: 'Plugin Metric', windowed: false },
  'plugin-table': { binds: 'none', title: 'Plugin Table', windowed: false },
  'plugin-action': { binds: 'none', title: 'Plugin Action', windowed: false },
  'plugin-log': { binds: 'none', title: 'Plugin Events', windowed: false },
} as const satisfies Record<string, PanelTypeSpec>

/** A panel type this build implements. */
export type PanelType = keyof typeof PANEL_TYPES

/** Every panel type, in palette order. */
export const PANEL_TYPE_IDS = Object.keys(PANEL_TYPES) as PanelType[]

/**
 * Whether this build implements the panel type.
 *
 * A saved document can name a type this build has never heard of — a newer
 * version added one, and the dashboard was rolled back. That panel keeps its
 * slot and renders as an unsupported-panel placeholder, because dropping it
 * would silently reflow an arrangement the operator authored.
 */
export function isKnownPanelType(type: string): type is PanelType {
  return Object.hasOwn(PANEL_TYPES, type)
}

/**
 * What the panel binds to. An unimplemented type binds to nothing: there is no
 * data to point at something that cannot be rendered.
 */
export function panelBindingKind(type: string): PanelBindingKind {
  return isKnownPanelType(type) ? PANEL_TYPES[type].binds : 'none'
}

/**
 * The title to show when the operator has not renamed the panel. An
 * unimplemented type falls back to its raw id so the placeholder can name what
 * it could not render.
 */
export function defaultPanelTitle(type: string): string {
  return isKnownPanelType(type) ? PANEL_TYPES[type].title : type
}

/**
 * The cells a newly placed panel takes. Click-to-add puts the panel in the
 * first free slot of this size and the operator moves it from there, so this
 * only has to be a sane starting point rather than the right answer.
 */
export function defaultPanelSize(type: string): PanelSize {
  return (isKnownPanelType(type) ? panelSpec(type).size : undefined) ?? DEFAULT_PANEL_SIZE
}

/**
 * Whether the panel's own time window reaches its rendering — the question the
 * settings ask before offering the operator a window to choose.
 *
 * An unimplemented type answers false: it renders a placeholder, so nothing it
 * carries reaches a chart. Its stored window is left untouched all the same,
 * because the build that understands the type will want it.
 */
export function panelUsesWindow(type: string): boolean {
  return isKnownPanelType(type) && panelSpec(type).windowed !== false
}

const NO_METRIC_GROUPS: readonly MetricGroup[] = []

/**
 * The metric groups a panel type shows — empty for a type that shows no engine
 * metrics, and for one this build does not implement. The same array on every
 * call, so a caller can depend on it.
 */
export function panelMetricGroups(type: string): readonly MetricGroup[] {
  return (isKnownPanelType(type) ? panelSpec(type).metricGroups : undefined) ?? NO_METRIC_GROUPS
}

/**
 * One type's declaration, read as the interface rather than as its own literal
 * type — which is what makes the optional fields readable on the types that
 * leave them out.
 */
function panelSpec(type: PanelType): PanelTypeSpec {
  return PANEL_TYPES[type]
}
