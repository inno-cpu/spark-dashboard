import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { defaultDashboardDocument } from './preset'
import {
  DASHBOARD_SCHEMA_VERSION,
  parseDashboardDocument,
  serializeDashboardDocument,
  type DashboardDocument,
} from './schema'

/**
 * The v3 contract, against a real document.
 *
 * `V2_RAW` is the dashboard exactly as Spark 0.16.0 had stored it before the
 * plugin work: two pages, ten native panels, bindings and time windows included.
 * It was copied verbatim from `/var/backups/spark/dashboards.pre-plugin-v3.json`
 * (the file backed up before the schema was bumped), so these tests fail if the
 * migration ever stops preserving something an operator had arranged by hand.
 */
const V2_RAW = `{"version":2,"pages":[{"id":"overview","name":"Overview","panels":[{"id":"decode","type":"engine-decode-throughput","geometry":{"x":0,"y":0,"w":6,"h":3},"binding":{"kind":"follow"},"window":"5m"},{"id":"latency","type":"engine-latency","geometry":{"x":6,"y":0,"w":3,"h":3},"binding":{"kind":"follow"},"window":"5m"},{"id":"requests","type":"engine-requests","geometry":{"x":9,"y":0,"w":3,"h":3},"binding":{"kind":"follow"},"window":"5m"},{"id":"gpu-util","type":"gpu-utilization","geometry":{"x":0,"y":3,"w":6,"h":3},"binding":{"kind":"follow"},"window":"5m"},{"id":"gpu-power","type":"gpu-power","geometry":{"x":6,"y":3,"w":3,"h":3},"binding":{"kind":"follow"},"window":"5m"},{"id":"gpu-temp","type":"gpu-temperature","geometry":{"x":9,"y":3,"w":3,"h":3},"binding":{"kind":"follow"},"window":"5m"},{"id":"cpu","type":"cpu-utilization","geometry":{"x":0,"y":6,"w":3,"h":2},"binding":{"kind":"follow"},"window":"5m"},{"id":"memory","type":"memory","geometry":{"x":3,"y":6,"w":3,"h":2},"binding":{"kind":"follow"},"window":"5m"},{"id":"disk","type":"disk-io","geometry":{"x":6,"y":6,"w":3,"h":2},"binding":{"kind":"follow"},"window":"5m"},{"id":"network","type":"network-io","geometry":{"x":9,"y":6,"w":3,"h":2},"binding":{"kind":"follow"},"window":"5m"}]},{"id":"page-2","name":"Page 2","panels":[]}]}`

const v2 = () => JSON.parse(V2_RAW)

/** The same real document as a v1 build would have stored it. */
function asV1(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, version: 1 }
}

function migrated(document: unknown): DashboardDocument {
  const parsed = parseDashboardDocument(document)
  expect(parsed).not.toBeNull()
  return parsed as DashboardDocument
}

describe('migrating real documents forward', () => {
  it('v2 → v3 preserves every page, panel, binding and window', () => {
    const outcome = runMigrations(v2(), 2)
    expect(outcome.status).toBe('migrated')
    expect((outcome as { ran: number }).ran).toBe(1)

    const document = migrated((outcome as { document: unknown }).document)
    expect(document.version).toBe(DASHBOARD_SCHEMA_VERSION)

    const original = v2()
    expect(document.pages.map((page) => page.id)).toEqual(['overview', 'page-2'])
    expect(document.pages.map((page) => page.name)).toEqual(['Overview', 'Page 2'])
    expect(document.pages[0].panels).toHaveLength(10)

    // Every native panel keeps its id, type, geometry, binding and window.
    for (const [index, panel] of document.pages[0].panels.entries()) {
      expect(panel).toMatchObject({
        id: original.pages[0].panels[index].id,
        type: original.pages[0].panels[index].type,
        geometry: original.pages[0].panels[index].geometry,
        binding: original.pages[0].panels[index].binding,
        window: original.pages[0].panels[index].window,
      })
      expect(panel.config).toBeUndefined()
    }
  })

  it('v1 → v2 → v3 runs both steps and keeps the same panels', () => {
    const outcome = runMigrations(asV1(v2()), 1)
    expect(outcome.status).toBe('migrated')
    expect((outcome as { ran: number }).ran).toBe(2)
    const document = migrated((outcome as { document: unknown }).document)
    expect(document.version).toBe(DASHBOARD_SCHEMA_VERSION)
    expect(document.pages[0].panels).toHaveLength(10)
    expect(document.pages[0].panels[0].geometry).toEqual({ x: 0, y: 0, w: 6, h: 3 })
  })

  it('does not rewrite the document it was given', () => {
    const input = v2()
    const snapshot = JSON.stringify(input)
    const outcome = runMigrations(input, 2)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect((outcome as { document: unknown }).document).not.toBe(input)
  })

  it('writes nothing until a save: the migrated document differs only in version', () => {
    const outcome = runMigrations(v2(), 2)
    const written = JSON.parse(serializeDashboardDocument(migrated((outcome as { document: unknown }).document)))
    const original = v2()
    expect({ ...written, version: 2 }).toEqual(original)
  })

  it('refuses a document from a newer build instead of overwriting it', () => {
    const future = { ...v2(), version: DASHBOARD_SCHEMA_VERSION + 1 }
    expect(parseDashboardDocument(future)).toBeNull()
    expect(runMigrations(future, DASHBOARD_SCHEMA_VERSION + 1).status).toBe('unmigratable')
  })
})

function documentWithPluginPanel(config: Record<string, unknown> | undefined): DashboardDocument {
  const document = defaultDashboardDocument()
  const page = document.pages[0]
  page.panels.push({
    id: 'plugin-status-1',
    type: 'plugin-status',
    title: 'Acme backend',
    geometry: { x: 0, y: 0, w: 3, h: 2 },
    binding: page.panels[0].binding,
    window: '5m',
    ...(config === undefined ? {} : { config }),
  })
  return document
}

describe('generic plugin panel config', () => {
  it('survives parse → serialize → parse', () => {
    const config = {
      plugin: 'acme-test',
      path: '/status',
      refresh_s: 5,
      fields: [{ label: 'Uptime', key: 'uptime_s', unit: 's' }],
    }
    const once = migrated(JSON.parse(serializeDashboardDocument(documentWithPluginPanel(config))))
    const panel = once.pages[0].panels.find((candidate) => candidate.type === 'plugin-status')
    expect(panel?.config).toEqual(config)

    const twice = migrated(JSON.parse(serializeDashboardDocument(once)))
    expect(twice.pages[0].panels.find((candidate) => candidate.type === 'plugin-status')?.config).toEqual(
      config,
    )
    expect(serializeDashboardDocument(twice)).toBe(serializeDashboardDocument(once))
  })

  it('leaves native panels without a config key', () => {
    const serialized = serializeDashboardDocument(documentWithPluginPanel({ plugin: 'acme-test' }))
    const document = migrated(JSON.parse(serialized))
    const native = document.pages[0].panels.find((candidate) => candidate.type === 'gpu-temperature')
    expect(native).toBeDefined()
    expect(native?.config).toBeUndefined()

    // Written shape, not just the parsed one: absence is what "never configured" means.
    const written = JSON.parse(serialized)
    const nativeRaw = written.pages[0].panels.find(
      (panel: { type: string }) => panel.type === 'gpu-temperature',
    )
    expect(nativeRaw).toBeDefined()
    expect('config' in nativeRaw).toBe(false)
    expect(written.pages[0].panels.some((panel: { config?: unknown }) => 'config' in panel)).toBe(true)
  })

  it('accepts a plugin panel with no config at all', () => {
    const document = migrated(JSON.parse(serializeDashboardDocument(documentWithPluginPanel(undefined))))
    const panel = document.pages[0].panels.find((candidate) => candidate.type === 'plugin-status')
    expect(panel).toBeDefined()
    expect(panel?.config).toBeUndefined()
  })

  it('keeps a plugin panel type this build does not implement', () => {
    const document = documentWithPluginPanel({ plugin: 'future' })
    document.pages[0].panels.push({
      ...document.pages[0].panels[0],
      id: 'future-panel',
      type: 'plugin-future',
    })
    const parsed = migrated(JSON.parse(serializeDashboardDocument(document)))
    expect(parsed.pages[0].panels.some((panel) => panel.type === 'plugin-future')).toBe(true)
  })

  it('preserves a page source selection', () => {
    const document = documentWithPluginPanel({ plugin: 'acme-test' })
    document.pages[0].source = { kind: 'engine', endpoint: 'http://127.0.0.1:9997' }
    const parsed = migrated(JSON.parse(serializeDashboardDocument(document)))
    expect(parsed.pages[0].source).toEqual({ kind: 'engine', endpoint: 'http://127.0.0.1:9997' })
  })
})
