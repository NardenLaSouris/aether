import { describe, expect, it, vi } from 'vitest'
import { QuotaManager, type QuotaManagerDependencies } from '../../src/main/quota/quotaManager'
import type { QuotaEventRecord } from '../../src/shared/domain'
import type { TurnResultPayload, UsageApiResult } from '../../src/shared/engineProtocol'

interface Harness {
  manager: QuotaManager
  clock: { now: number }
  timers: { callback: () => void; at: number; cancelled: boolean }[]
  notifications: string[]
  events: Omit<QuotaEventRecord, 'id' | 'createdAt'>[]
  readUsage: ReturnType<typeof vi.fn>
  advance: (milliseconds: number) => Promise<void>
}

function harness(usage?: () => Promise<UsageApiResult>): Harness {
  const clock = { now: Date.parse('2026-11-07T10:00:00Z') }
  const timers: Harness['timers'] = []
  const notifications: string[] = []
  const events: Harness['events'] = []
  const readUsage = vi.fn(usage ?? (async (): Promise<UsageApiResult> => ({ subscriptionType: 'pro', rateLimitsAvailable: true, windows: {}, sessionCostUsd: null })))
  const dependencies: QuotaManagerDependencies = {
    now: () => clock.now,
    setTimer: (callback, delay) => {
      const timer = { callback, at: clock.now + delay, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
    notify: (title) => notifications.push(title),
    recordEvent: (event) => events.push(event),
    readUsage,
    onStateChange: () => undefined,
    isSubscriptionAccount: () => true,
    pollIntervalMs: 15 * 60_000
  }
  const manager = new QuotaManager(dependencies)
  const advance = async (milliseconds: number): Promise<void> => {
    const target = clock.now + milliseconds
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((left, right) => left.at - right.at)[0]
      if (!due) break
      clock.now = due.at
      due.cancelled = true
      due.callback()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    clock.now = target
  }
  return { manager, clock, timers, notifications, events, readUsage, advance }
}

const errorResult = (text: string, status: number | null = null): TurnResultPayload => ({ subtype: 'success', isError: true, durationMs: 1, totalCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, errors: [], resultText: text, apiErrorStatus: status, model: null })

describe('QuotaManager — five-hour limit with a known reset', () => {
  it('suspends sending, then re-enables it exactly at the reported reset time', async () => {
    const { manager, clock, advance, notifications, events } = harness()
    const resetsAtSeconds = Math.round((clock.now + 2 * 3_600_000) / 1000)
    manager.handleRateLimit({ status: 'rejected', resetsAt: resetsAtSeconds, rateLimitType: 'five_hour', utilization: 1 })

    const decision = manager.canSend()
    expect(decision.allowed).toBe(false)
    expect(manager.snapshot.block).toMatchObject({ limitKind: 'five_hour', resetsAt: resetsAtSeconds * 1000 })
    expect(events[0]).toMatchObject({ eventType: 'limit_detected', limitKind: 'five_hour' })
    expect(notifications).toHaveLength(1)

    await advance(3_600_000)
    expect(manager.canSend().allowed).toBe(false)

    await advance(3_600_000 + 10_000)
    expect(manager.canSend().allowed).toBe(true)
    expect(events.map((event) => event.eventType)).toContain('reset_time_reached')
    expect(notifications.at(-1)).toBe('Envois réactivés')
  })

  it('never resends the refused request: it only reads the usage API', async () => {
    const { manager, readUsage, advance, clock } = harness()
    manager.handleRateLimit({ status: 'rejected', resetsAt: Math.round((clock.now + 60_000) / 1000), rateLimitType: 'five_hour' })
    await advance(70_000)
    // One confirmation read after the reset; nothing else is sent.
    expect(readUsage).toHaveBeenCalledTimes(1)
  })
})

describe('QuotaManager — unknown reset time', () => {
  it('stays blocked and polls the official usage API at a slow interval until capacity is confirmed', async () => {
    let utilization = 100
    const { manager, advance, readUsage, events } = harness(async () => ({ subscriptionType: 'pro', rateLimitsAvailable: true, windows: { five_hour: { utilization, resets_at: null } }, sessionCostUsd: null }))
    manager.handleTurnResult(errorResult("You've hit your session limit"))
    expect(manager.snapshot.block).toMatchObject({ resetsAt: null, limitKind: 'unknown_usage_limit' })
    expect(manager.snapshot.nextAutomaticCheckAt).not.toBeNull()

    await advance(14 * 60_000)
    expect(readUsage).not.toHaveBeenCalled()
    await advance(60_000)
    expect(readUsage).toHaveBeenCalledTimes(1)
    expect(manager.canSend().allowed).toBe(false)

    utilization = 12
    await advance(15 * 60_000)
    expect(readUsage).toHaveBeenCalledTimes(2)
    expect(manager.canSend().allowed).toBe(true)
    expect(events.map((event) => event.eventType)).toContain('reset_confirmed')
  })

  it('learns the reset time from the usage API when it becomes available', async () => {
    const { manager, clock } = harness(async () => ({ subscriptionType: 'pro', rateLimitsAvailable: true, windows: { five_hour: { utilization: 100, resets_at: new Date(clock.now + 3_600_000).toISOString() } }, sessionCostUsd: null }))
    manager.handleRateLimit({ status: 'rejected', rateLimitType: 'five_hour' })
    expect(manager.snapshot.block?.resetsAt).toBeNull()
    await manager.checkNow()
    expect(manager.snapshot.block?.resetsAt).toBe(Math.floor((clock.now + 3_600_000) / 1000) * 1000)
  })
})

describe('QuotaManager — non-quota failures', () => {
  it('does not block on authentication or network errors', () => {
    const { manager } = harness()
    expect(manager.handleAssistantError('authentication_failed', 'Invalid API key')).toBe('authentication')
    expect(manager.handleTurnResult(errorResult('fetch failed: ECONNREFUSED'))).toBe('network')
    expect(manager.canSend().allowed).toBe(true)
  })

  it('records warnings without blocking', () => {
    const { manager, events } = harness()
    manager.handleRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9 })
    expect(manager.canSend().allowed).toBe(true)
    expect(events[0]).toMatchObject({ eventType: 'warning', utilizationPercent: 90 })
    expect(manager.snapshot.windows[0]).toMatchObject({ kind: 'seven_day', status: 'allowed_warning' })
  })

  it('a manual clear is recorded as such', () => {
    const { manager, events } = harness()
    manager.handleRateLimit({ status: 'rejected', rateLimitType: 'seven_day' })
    manager.clearManually()
    expect(manager.canSend().allowed).toBe(true)
    expect(events.at(-1)?.eventType).toBe('cleared_manually')
  })

  it('keeps the usage API error visible', async () => {
    const { manager } = harness(async () => {
      throw new Error('not available')
    })
    await manager.checkNow()
    expect(manager.snapshot.usageApiError).toBe('not available')
  })
})
