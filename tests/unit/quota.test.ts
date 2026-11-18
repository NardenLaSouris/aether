import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { QuotaBlock } from '../../src/shared/domain'
import {
  blockFromErrorText,
  blockFromRateLimitEvent,
  classifyEngineError,
  combineBlocks,
  evaluateBlock,
  formatDuration,
  isUsageLimitMessage,
  mergeWindows,
  nextCheckDelay,
  normaliseEpoch,
  normaliseFractionToPercent,
  shouldLiftBlockAfterCheck,
  windowFromRateLimitEvent,
  windowsFromUsageApi
} from '../../src/shared/quota'

const NOW = Date.parse('2026-11-07T10:00:00Z')

describe('normalisation', () => {
  it('treats small epochs as seconds and large ones as milliseconds', () => {
    expect(normaliseEpoch(1_900_000_000)).toBe(1_900_000_000_000)
    expect(normaliseEpoch(1_900_000_000_000)).toBe(1_900_000_000_000)
    expect(normaliseEpoch(undefined)).toBeNull()
    expect(normaliseEpoch(0)).toBeNull()
  })

  it('converts utilisation fractions to percents', () => {
    expect(normaliseFractionToPercent(0.42)).toBe(42)
    expect(normaliseFractionToPercent(1)).toBe(100)
    expect(normaliseFractionToPercent(87)).toBe(87)
    expect(normaliseFractionToPercent(undefined)).toBeNull()
  })

  it('stays in sync with the SDK usage-limit prefixes', () => {
    for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) expect(isUsageLimitMessage(`${prefix} limit · resets 5pm`)).toBe(true)
  })
})

describe('error classification', () => {
  it('distinguishes usage limits, API limits, authentication and network failures', () => {
    expect(classifyEngineError({ text: "You've hit your session limit · resets 3pm", isSubscription: true })).toBe('usage_limit')
    expect(classifyEngineError({ assistantError: 'rate_limit', isSubscription: false })).toBe('api_rate_limit')
    expect(classifyEngineError({ httpStatus: 429, isSubscription: true })).toBe('usage_limit')
    expect(classifyEngineError({ assistantError: 'authentication_failed', isSubscription: true })).toBe('authentication')
    expect(classifyEngineError({ httpStatus: 401, isSubscription: true })).toBe('authentication')
    expect(classifyEngineError({ text: 'fetch failed: ECONNRESET', isSubscription: true })).toBe('network')
    expect(classifyEngineError({ assistantError: 'overloaded', isSubscription: true })).toBe('overloaded')
    expect(classifyEngineError({ assistantError: 'model_not_found', isSubscription: true })).toBe('model_unavailable')
    expect(classifyEngineError({ text: 'Something else', isSubscription: true })).toBe('other')
  })
})

describe('blocks', () => {
  it('creates a block only for rejected rate-limit events, with the reported reset time', () => {
    expect(blockFromRateLimitEvent({ status: 'allowed_warning', resetsAt: 1_900_000_000 }, NOW)).toBeNull()
    const block = blockFromRateLimitEvent({ status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' }, NOW)
    expect(block).toMatchObject({ reason: 'subscription_limit', limitKind: 'five_hour', resetsAt: 1_900_000_000_000, source: 'rate_limit_event' })
  })

  it('never invents a reset time from free text', () => {
    const block = blockFromErrorText("You've hit your limit · resets 3pm", 'usage_limit', [], NOW)
    expect(block.resetsAt).toBeNull()
    expect(block.limitKind).toBe('unknown_usage_limit')
  })

  it('reuses the reset time of a known rejected window', () => {
    const windows = [windowFromRateLimitEvent({ status: 'rejected', resetsAt: (NOW + 3_600_000) / 1000, rateLimitType: 'seven_day' }, NOW)]
    const block = blockFromErrorText("You've reached your weekly limit", 'usage_limit', windows, NOW)
    expect(block).toMatchObject({ limitKind: 'seven_day', resetsAt: NOW + 3_600_000 })
  })

  it('keeps the longest block', () => {
    const short: QuotaBlock = { reason: 'subscription_limit', limitKind: 'five_hour', resetsAt: NOW + 1000, detectedAt: NOW, message: '', source: 'rate_limit_event' }
    const long: QuotaBlock = { ...short, limitKind: 'seven_day', resetsAt: NOW + 100_000 }
    expect(combineBlocks(short, long)).toBe(long)
    expect(combineBlocks(long, short)).toBe(long)
    expect(combineBlocks(null, short)).toBe(short)
  })
})

describe('resume timing', () => {
  const block: QuotaBlock = { reason: 'subscription_limit', limitKind: 'five_hour', resetsAt: NOW + 90_000, detectedAt: NOW, message: 'x', source: 'rate_limit_event' }

  it('computes the remaining time and detects the reset moment', () => {
    expect(evaluateBlock(block, NOW)).toEqual({ blocked: true, resetTimeReached: false, millisecondsRemaining: 90_000 })
    expect(evaluateBlock(block, NOW + 90_000)).toEqual({ blocked: false, resetTimeReached: true, millisecondsRemaining: 0 })
    expect(evaluateBlock({ ...block, resetsAt: null }, NOW)).toEqual({ blocked: true, resetTimeReached: false, millisecondsRemaining: null })
    expect(evaluateBlock(null, NOW).blocked).toBe(false)
  })

  it('schedules a check just after a known reset, or a slow poll when unknown', () => {
    expect(nextCheckDelay(block, NOW, 900_000)).toBe(95_000)
    expect(nextCheckDelay({ ...block, resetsAt: null }, NOW, 900_000)).toBe(900_000)
    expect(nextCheckDelay(null, NOW, 900_000)).toBeNull()
  })

  it('formats durations', () => {
    expect(formatDuration(65_000)).toBe('1 min 05 s')
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 05 min 00 s')
    expect(formatDuration(3 * 86_400_000)).toBe('3 j 00 h 00 min')
  })
})

describe('usage API windows', () => {
  it('parses percent utilisation and ISO reset times', () => {
    const windows = windowsFromUsageApi({ subscriptionType: 'pro', rateLimitsAvailable: true, windows: { five_hour: { utilization: 100, resets_at: '2026-11-07T12:00:00Z' }, seven_day: { utilization: 35.5, resets_at: null } }, sessionCostUsd: null }, NOW)
    expect(windows).toEqual([
      { kind: 'five_hour', utilizationPercent: 100, resetsAt: Date.parse('2026-11-07T12:00:00Z'), status: 'rejected', observedAt: NOW, source: 'usage_api' },
      { kind: 'seven_day', utilizationPercent: 35.5, resetsAt: null, status: null, observedAt: NOW, source: 'usage_api' }
    ])
  })

  it('lifts a block only when fresh official data shows capacity', () => {
    const block: QuotaBlock = { reason: 'subscription_limit', limitKind: 'five_hour', resetsAt: null, detectedAt: NOW, message: 'x', source: 'error_message' }
    const stillFull = windowsFromUsageApi({ subscriptionType: null, rateLimitsAvailable: true, windows: { five_hour: { utilization: 100, resets_at: '2026-11-07T12:00:00Z' } }, sessionCostUsd: null }, NOW + 1000)
    expect(shouldLiftBlockAfterCheck(block, stillFull, NOW + 1000)).toBe(false)
    const freed = windowsFromUsageApi({ subscriptionType: null, rateLimitsAvailable: true, windows: { five_hour: { utilization: 3, resets_at: '2026-11-07T15:00:00Z' } }, sessionCostUsd: null }, NOW + 2000)
    expect(shouldLiftBlockAfterCheck(block, freed, NOW + 2000)).toBe(true)
    // Stale data (observed before the block) never lifts it.
    const stale = windowsFromUsageApi({ subscriptionType: null, rateLimitsAvailable: true, windows: { five_hour: { utilization: 3, resets_at: null } }, sessionCostUsd: null }, NOW - 5000)
    expect(shouldLiftBlockAfterCheck(block, stale, NOW)).toBe(false)
  })

  it('merges observations keeping the latest per window', () => {
    const first = windowFromRateLimitEvent({ status: 'allowed', resetsAt: (NOW + 10_000) / 1000, rateLimitType: 'five_hour', utilization: 0.5 }, NOW)
    const second = windowFromRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'five_hour' }, NOW + 1)
    const merged = mergeWindows([first], [second])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ status: 'allowed_warning', utilizationPercent: 50, resetsAt: NOW + 10_000 })
  })
})
