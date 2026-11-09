import type { EngineSnapshot } from '@/types/metrics'

/**
 * How a router backend is tied to the engine metrics Spark already collects.
 *
 * The router exposes `model_uid` for a backend it was configured with; the engine
 * snapshot exposes the endpoint Spark polls, which for the bridge ends in that uid.
 * Matching on the uid is explicit and unique — GPU UUIDs are deliberately not used,
 * because two models can share a card and a wrong association would show someone
 * else's throughput under this backend's name.
 */
export type EngineAssociation =
  | { status: 'resolved'; engine: EngineSnapshot }
  | { status: 'unavailable'; reason: 'no-identity' | 'not-loaded' | 'ambiguous'; candidates: number }

/** The uid a backend names, or null when it has none. */
export function backendModelUid(backend: { model_uid?: unknown } | null | undefined): string | null {
  const uid = backend?.model_uid
  return typeof uid === 'string' && uid.length > 0 ? uid : null
}

/** Engines whose endpoint ends with `/<uid>` — the bridge's per-model endpoint. */
export function enginesForUid(
  engines: readonly EngineSnapshot[],
  uid: string,
): EngineSnapshot[] {
  const suffix = `/${uid.replace(/\/+$/, '')}`
  return engines.filter((engine) => engine.endpoint.replace(/\/+$/, '').endsWith(suffix))
}

/**
 * The engine behind a router backend, or why it cannot be named.
 *
 * `not-loaded` is the normal idle answer: the backend has a uid but no engine is
 * serving it. `ambiguous` means two engines claim the same uid (a restarting
 * process and its replacement), and the panel says so instead of picking one.
 */
export function associateRouterBackend(
  engines: readonly EngineSnapshot[],
  backend: { model_uid?: unknown } | null | undefined,
): EngineAssociation {
  const uid = backendModelUid(backend)
  if (uid === null) return { status: 'unavailable', reason: 'no-identity', candidates: 0 }
  const matches = enginesForUid(engines, uid)
  if (matches.length === 0) return { status: 'unavailable', reason: 'not-loaded', candidates: 0 }
  if (matches.length > 1) return { status: 'unavailable', reason: 'ambiguous', candidates: matches.length }
  return { status: 'resolved', engine: matches[0] }
}
