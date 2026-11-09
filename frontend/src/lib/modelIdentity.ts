export function formatGpuName(name: string | number | null | undefined): string {
  if (typeof name === 'number') return `GPU ${name}`
  const value = (name ?? '').trim()
  if (/^\d+$/.test(value)) return `GPU ${value}`
  const match = /^gpu(\d+)$/i.exec(value)
  return match ? `GPU ${match[1]}` : (value || 'GPU ?')
}

/**
 * The profile ID carries the context variant (-160k/-256k/-512k). Do not append
 * a second "256K ctx" token: the profile name is the single context label.
 */
export function formatProfileLabel(profile: string | null | undefined): string {
  return (profile ?? '').trim() || 'unknown profile'
}

/** Full placement label used by Loaded models and GPU cards. */
export function formatGpuProfileLabel(
  gpu: string | number | null | undefined,
  profile: string | null | undefined,
): string {
  return `${formatGpuName(gpu)} · ${formatProfileLabel(profile)}`
}
