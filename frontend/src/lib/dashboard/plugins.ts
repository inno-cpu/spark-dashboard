/**
 * Templates contributed by installed plugins, discovered at runtime.
 *
 * A plugin template is a starting layout and nothing else: the same
 * `StartingLayout` the built-in Legacy arrangement is, so a page made from it is
 * an ordinary dashboard page — native editor, native palette, native page
 * configuration, native persistence. Nothing here creates a page; installing a
 * plugin adds an entry to a menu.
 */

import { useEffect, useState } from 'react'
import { FOLLOW } from './bindings'
import type { PanelGeometry } from './grid'
import { DEFAULT_TIME_WINDOW, type DashboardPanel } from './schema'
import type { StartingLayout } from './startingLayouts'

/** Same-origin: Spark proxies to the plugin host, the browser never sees :3199. */
const PLUGIN_API = '/api/plugins'

export interface PluginPanelSpec {
  type: string
  title?: string
  geometry: PanelGeometry
  config?: Record<string, unknown>
}

export interface PluginTemplate {
  id: string
  name: string
  panels: PluginPanelSpec[]
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  enabled: boolean
  has_backend: boolean
  templates: PluginTemplate[]
}

/** A template as the layout New page consumes. New panels on every call. */
export function templateToLayout(template: PluginTemplate): StartingLayout {
  return {
    name: template.name,
    panels: (): DashboardPanel[] =>
      template.panels.map((spec, index) => ({
        id: `plugin-${template.id}-${index + 1}`,
        type: spec.type,
        ...(spec.title === undefined ? {} : { title: spec.title }),
        geometry: { ...spec.geometry },
        binding: FOLLOW,
        window: DEFAULT_TIME_WINDOW,
        ...(spec.config === undefined ? {} : { config: spec.config }),
      })),
  }
}

/** Every template of every enabled plugin, in registry order. */
export async function fetchPluginTemplates(signal?: AbortSignal): Promise<StartingLayout[]> {
  const response = await fetch(PLUGIN_API, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`plugin host answered ${response.status}`)
  const body = (await response.json()) as { plugins?: PluginInfo[] }
  const plugins = Array.isArray(body.plugins) ? body.plugins : []
  return plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.templates.map(templateToLayout))
}

/**
 * The templates to offer, or none.
 *
 * An empty list is the normal answer when no plugin is installed, when the host
 * is down and when every plugin is disabled — none of which is an error the
 * dashboard should raise, because Spark works without any of it.
 */
export function usePluginTemplates(): StartingLayout[] {
  const [templates, setTemplates] = useState<StartingLayout[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetchPluginTemplates(controller.signal)
      .then(setTemplates)
      .catch(() => setTemplates([]))
    return () => controller.abort()
  }, [])

  return templates
}
