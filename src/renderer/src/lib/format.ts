const relativeFormatter = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' })

export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const deltaSeconds = Math.round((timestamp - now) / 1000)
  const absolute = Math.abs(deltaSeconds)
  if (absolute < 45) return 'à l’instant'
  if (absolute < 3600) return relativeFormatter.format(Math.round(deltaSeconds / 60), 'minute')
  if (absolute < 86_400) return relativeFormatter.format(Math.round(deltaSeconds / 3600), 'hour')
  if (absolute < 86_400 * 30) return relativeFormatter.format(Math.round(deltaSeconds / 86_400), 'day')
  return new Date(timestamp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const numberFormatter = new Intl.NumberFormat('fr-FR')

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace('.', ',')} M`
  if (value >= 10_000) return `${(value / 1000).toFixed(1).replace('.', ',')} k`
  return numberFormatter.format(value)
}

export function formatUsd(value: number | null): string {
  if (value === null) return '—'
  return `${value < 0.01 && value > 0 ? '< 0,01' : value.toFixed(2).replace('.', ',')} $`
}

export function formatSeconds(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(1).replace('.', ',')} s`
}

export function shortPath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) return path
  const parts = path.split(/[\\/]/)
  const tail = parts.slice(-2).join('\\')
  return `…\\${tail}`.slice(-maxLength)
}
