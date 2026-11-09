/**
 * Shared GET poll cache: one in-flight request and one cached response per URL.
 *
 * Panels poll independently (19 intervals at last count). This collapses identical
 * concurrent polls onto one request, serves a short-lived cached response to the
 * rest, and — the important part — keeps the last good payload when a poll fails.
 * A panel that receives stale data shows numbers instead of blanking to an error,
 * and a fixed badge says the data is stale.
 *
 * While the tab is hidden, cached responses are served without any network calls;
 * the first visible poll resumes normally.
 */

const CACHE_TTL_MS = 1500

interface Entry {
  at: number
  response?: Response
  inflight?: Promise<Response>
}

const cache = new Map<string, Entry>()
const staleKeys = new Set<string>()
let badge: HTMLDivElement | null = null
let installed = false

function renderBadge(): void {
  if (!badge) {
    badge = document.createElement('div')
    badge.id = 'spark-stale-badge'
    badge.setAttribute('role', 'status')
    badge.setAttribute('aria-live', 'polite')
    badge.style.cssText = [
      'position:fixed', 'right:10px', 'bottom:10px', 'z-index:9999',
      'padding:4px 8px', 'border-radius:4px', 'font:11px ui-monospace,monospace',
      'background:#3a2a06', 'color:#eab308', 'border:1px solid #6b520f',
      'display:none',
    ].join(';')
    document.body.appendChild(badge)
  }
  const stale = staleKeys.size > 0
  badge.style.display = stale ? 'block' : 'none'
  badge.textContent = stale ? `stale data — ${staleKeys.size} endpoint(s) failing` : ''
}

/** Staleness is per endpoint: one failing poll must not be cleared by another
 *  endpoint succeeding, and one success must not hide the failure. */
function markStale(key: string, value: boolean): void {
  let changed = false
  if (value) {
    changed = !staleKeys.has(key)
    staleKeys.add(key)
  } else {
    changed = staleKeys.delete(key)
  }
  if (changed) renderBadge()
}

function isApiGet(input: RequestInfo | URL, init?: RequestInit): string | null {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET') return null
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  let url: URL
  try {
    url = new URL(raw, window.location.origin)
  } catch {
    return null
  }
  if (url.origin !== window.location.origin) return null
  if (!url.pathname.startsWith('/api/')) return null
  return url.toString()
}

export function installPollCache(): void {
  if (installed) return
  installed = true
  const original = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = isApiGet(input, init)
    if (key === null) return original(input, init)

    const entry = cache.get(key) ?? { at: 0 }
    cache.set(key, entry)

    if (document.hidden && entry.response) return entry.response.clone()
    if (entry.response && Date.now() - entry.at < CACHE_TTL_MS) return entry.response.clone()
    if (entry.inflight) return entry.inflight.then((response) => response.clone())

    entry.inflight = original(input, init)
      .then((response) => {
        if (response.ok) {
          entry.response = response.clone()
          entry.at = Date.now()
          markStale(key, false)
          return response
        }
        if (entry.response) {
          markStale(key, true)
          return entry.response.clone()
        }
        return response
      })
      .catch((error: unknown) => {
        if (entry.response) {
          markStale(key, true)
          return entry.response.clone()
        }
        throw error
      })
      .finally(() => {
        entry.inflight = undefined
      })

    return entry.inflight
  }

  // No visibilitychange handler: hidden polls are served from cache above, and a
  // stale endpoint stays marked until that endpoint itself succeeds again.
}