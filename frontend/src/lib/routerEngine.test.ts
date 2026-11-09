import { describe, expect, it } from 'vitest'
import type { EngineSnapshot } from '@/types/metrics'
import { associateRouterBackend, enginesForUid } from './routerEngine'

function engine(endpoint: string): EngineSnapshot {
  return { endpoint } as EngineSnapshot
}

describe('associateRouterBackend', () => {
  it('reports no identity when the backend names no model', () => {
    expect(associateRouterBackend([engine('http://x/models/a')], { model_uid: null }))
      .toEqual({ status: 'unavailable', reason: 'no-identity', candidates: 0 })
  })

  it('resolves the engine whose endpoint ends in the uid', () => {
    const found = engine('http://127.0.0.1:9997/extensions/spark-bridge/models/qwen38-gpu1')
    const association = associateRouterBackend([found], { model_uid: 'qwen38-gpu1' })
    expect(association).toEqual({ status: 'resolved', engine: found })
  })

  it('does not associate a different engine on the same host', () => {
    const other = engine('http://127.0.0.1:9997/extensions/spark-bridge/models/qwen38-gpu2')
    expect(associateRouterBackend([other], { model_uid: 'qwen38-gpu1' }))
      .toEqual({ status: 'unavailable', reason: 'not-loaded', candidates: 0 })
  })

  it('is unavailable, not wrong, when the model is not loaded', () => {
    expect(associateRouterBackend([], { model_uid: 'qwen38-gpu1' }))
      .toEqual({ status: 'unavailable', reason: 'not-loaded', candidates: 0 })
  })

  it('refuses to choose between two engines claiming one uid', () => {
    const stale = engine('http://127.0.0.1:9997/extensions/spark-bridge/models/qwen38-gpu1')
    const restarted = engine('http://127.0.0.1:9997/extensions/spark-bridge/models/qwen38-gpu1/')
    const association = associateRouterBackend([stale, restarted], { model_uid: 'qwen38-gpu1' })
    expect(association.status).toBe('unavailable')
    if (association.status === 'unavailable') {
      expect(association.reason).toBe('ambiguous')
      expect(association.candidates).toBe(2)
    }
  })

  it('matches nothing on a partial uid', () => {
    const long = engine('http://127.0.0.1:9997/extensions/spark-bridge/models/qwen38-gpu10')
    expect(enginesForUid([long], 'qwen38-gpu1')).toHaveLength(0)
  })
})
