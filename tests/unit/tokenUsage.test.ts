import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { TokenSample } from '../../src/shared/aetherMods'
import { pruneSamples, TOKEN_HISTORY_MS } from '../../src/renderer/src/mods/tokenUsageStore'

const require = createRequire(import.meta.url)
interface GaugeWindow {
  kind: string
  label?: string
  utilizationPercent: number | null
  resetsAt: number | null
  status: string | null
  observedAt: number
}
const { gaugeWindows, level, formatReset, formatAgo, shortLabel } = require('../../resources/mods/limites/gauges.js') as {
  gaugeWindows: (windows: GaugeWindow[]) => GaugeWindow[]
  level: (window: GaugeWindow) => string
  formatReset: (resetsAt: number | null, now: number) => string | null
  formatAgo: (at: number | null, now: number) => string
  shortLabel: (kind: string, fallback?: string) => string
}

describe('Limites Claude mod — gauges', () => {
  const window = (kind: string, values: Partial<GaugeWindow> = {}): GaugeWindow => ({ kind, utilizationPercent: 40, resetsAt: null, status: 'allowed', observedAt: 1, ...values })

  it('orders the windows and keeps the latest figure of each', () => {
    const shown = gaugeWindows([window('seven_day', { utilizationPercent: 30 }), window('api_rate_limit'), window('five_hour', { utilizationPercent: 10, observedAt: 1 }), window('five_hour', { utilizationPercent: 55, observedAt: 5 })])
    expect(shown.map((item) => [item.kind, item.utilizationPercent])).toEqual([
      ['five_hour', 55],
      ['seven_day', 30]
    ])
    expect(shortLabel('five_hour')).toBe('Session (5 h)')
  })

  it('colours by level, a reached limit always hot', () => {
    expect(level(window('five_hour', { utilizationPercent: 20 }))).toBe('calm')
    expect(level(window('five_hour', { utilizationPercent: 75 }))).toBe('warm')
    expect(level(window('five_hour', { utilizationPercent: 95 }))).toBe('hot')
    expect(level(window('five_hour', { utilizationPercent: 10, status: 'rejected' }))).toBe('hot')
    expect(level(window('five_hour', { utilizationPercent: null, status: 'allowed' }))).toBe('unknown')
  })

  it('says when the limit resets and how old the figure is', () => {
    const now = new Date(2026, 10, 7, 14, 16).getTime()
    expect(formatReset(new Date(2026, 10, 7, 16, 30).getTime(), now)).toBe('dans 2 h 14 (16:30)')
    expect(formatReset(new Date(2026, 10, 7, 14, 40).getTime(), now)).toBe('dans 24 min (14:40)')
    expect(formatReset(new Date(2026, 10, 10, 9, 0).getTime(), now)).toBe('dans 3 j (mar. 09:00)')
    expect(formatReset(now - 1, now)).toBeNull()
    expect(formatAgo(now - 4 * 60_000, now)).toBe('il y a 4 min')
    expect(formatAgo(null, now)).toBe('jamais')
  })
})

describe('token usage store', () => {
  it('keeps only the last 30 minutes', () => {
    const now = 10_000_000
    const sample = (at: number): TokenSample => ({ at, conversationId: 'a', model: 'm', inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, subagent: false })
    expect(pruneSamples([sample(now - TOKEN_HISTORY_MS - 1), sample(now - 1000)], now).map((item) => item.at)).toEqual([now - 1000])
  })
})
