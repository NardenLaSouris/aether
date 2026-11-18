/**
 * Pure quota logic. No I/O, no timers: everything takes `now` explicitly so it can be tested.
 *
 * Sources considered reliable (all come from the official Claude Code engine):
 *  - `rate_limit_event` stream messages (SDKRateLimitInfo) — status, resetsAt, rateLimitType, utilization
 *  - the SDK usage API (`usage_EXPERIMENTAL_...`) — utilization 0-100 and ISO reset timestamps
 *  - assistant `error: 'rate_limit'` and result texts starting with the SDK's USAGE_LIMIT_ERROR_PREFIXES
 * The 5-hour window is NEVER derived from the app start time.
 */
import type { LimitKind, LimitStatus, QuotaBlock, QuotaState, SubscriptionWindow } from './domain'
import type { RateLimitPayload, UsageApiResult } from './engineProtocol'

/** Copied from the SDK constant `USAGE_LIMIT_ERROR_PREFIXES` (kept in sync by a unit test). */
export const USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage"
]

const KNOWN_LIMIT_KINDS: readonly LimitKind[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage'
]

export const LIMIT_LABELS: Record<LimitKind, string> = {
  five_hour: 'Session (fenêtre de 5 heures)',
  seven_day: 'Hebdomadaire (7 jours)',
  seven_day_opus: 'Hebdomadaire Opus',
  seven_day_sonnet: 'Hebdomadaire Sonnet',
  seven_day_overage_included: 'Hebdomadaire (usage supplémentaire inclus)',
  overage: 'Usage supplémentaire',
  api_rate_limit: 'Limite de débit API',
  unknown_usage_limit: 'Limite d’usage (type non précisé)'
}

export function toLimitKind(rawType: string | undefined | null): LimitKind {
  if (rawType && (KNOWN_LIMIT_KINDS as readonly string[]).includes(rawType)) return rawType as LimitKind
  return 'unknown_usage_limit'
}

/**
 * `resetsAt` in rate_limit_event is a Unix timestamp. Claude Code emits seconds;
 * accept milliseconds too so a future change of unit cannot produce a date in 1970 or 50000 AD.
 */
export function normaliseEpoch(value: number | undefined | null): number | null {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return null
  return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value)
}

/** rate_limit_event utilization is a 0-1 fraction; convert to percent. Values > 1 are assumed to already be percents. */
export function normaliseFractionToPercent(value: number | undefined | null): number | null {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return null
  const percent = value <= 1 ? value * 100 : value
  return Math.min(100, Math.round(percent * 10) / 10)
}

export function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function windowFromRateLimitEvent(info: RateLimitPayload, now: number): SubscriptionWindow {
  return {
    kind: toLimitKind(info.rateLimitType),
    utilizationPercent: normaliseFractionToPercent(info.utilization),
    resetsAt: normaliseEpoch(info.resetsAt),
    status: info.status,
    observedAt: now,
    source: 'rate_limit_event'
  }
}

export function windowsFromUsageApi(result: UsageApiResult, now: number): SubscriptionWindow[] {
  const windows: SubscriptionWindow[] = []
  for (const [rawKind, rawWindow] of Object.entries(result.windows)) {
    if (!rawWindow) continue
    const resetsAt = parseIsoTimestamp(rawWindow.resets_at)
    const utilizationPercent = rawWindow.utilization === null ? null : Math.min(100, Math.max(0, rawWindow.utilization))
    windows.push({
      kind: toLimitKind(rawKind),
      utilizationPercent,
      resetsAt,
      status: utilizationPercent !== null && utilizationPercent >= 100 ? 'rejected' : null,
      observedAt: now,
      source: 'usage_api'
    })
  }
  return windows
}

/** Merge a new observation into the list, keeping the most recent one per kind. */
export function mergeWindows(existing: SubscriptionWindow[], incoming: SubscriptionWindow[]): SubscriptionWindow[] {
  const byKind = new Map<LimitKind, SubscriptionWindow>()
  for (const window of existing) byKind.set(window.kind, window)
  for (const window of incoming) {
    const previous = byKind.get(window.kind)
    if (!previous || previous.observedAt <= window.observedAt) {
      // Keep a known reset time / utilisation if the new observation lacks one and the old reset is still in the future.
      const keepReset = window.resetsAt === null && previous?.resetsAt != null && previous.resetsAt > window.observedAt
      byKind.set(window.kind, {
        ...window,
        resetsAt: keepReset ? (previous?.resetsAt ?? null) : window.resetsAt,
        utilizationPercent: window.utilizationPercent ?? previous?.utilizationPercent ?? null,
        status: window.status ?? previous?.status ?? null
      })
    }
  }
  return [...byKind.values()].sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind))
}

const KIND_ORDER: LimitKind[] = [...KNOWN_LIMIT_KINDS, 'api_rate_limit', 'unknown_usage_limit']

export function isUsageLimitMessage(text: string | null | undefined): boolean {
  if (!text) return false
  const trimmed = text.trim()
  return USAGE_LIMIT_PREFIXES.some((prefix) => trimmed.startsWith(prefix) || trimmed.includes(prefix))
}

export type ErrorCategory = 'usage_limit' | 'api_rate_limit' | 'authentication' | 'network' | 'overloaded' | 'billing' | 'model_unavailable' | 'other'

/**
 * Classify an engine error so that a temporary limit is never confused with an auth failure or a network outage.
 * `assistantError` is SDKAssistantMessageError when present.
 */
export function classifyEngineError(input: { assistantError?: string | null; text?: string | null; httpStatus?: number | null; isSubscription: boolean }): ErrorCategory {
  const { assistantError, text, httpStatus, isSubscription } = input
  if (assistantError === 'authentication_failed' || assistantError === 'oauth_org_not_allowed' || httpStatus === 401 || httpStatus === 403) return 'authentication'
  if (assistantError === 'billing_error' || assistantError === 'account_on_hold') return 'billing'
  if (assistantError === 'model_not_found') return 'model_unavailable'
  if (isUsageLimitMessage(text)) return 'usage_limit'
  if (assistantError === 'rate_limit' || httpStatus === 429) return isSubscription ? 'usage_limit' : 'api_rate_limit'
  if (assistantError === 'overloaded' || httpStatus === 529) return 'overloaded'
  if (assistantError === 'server_error' || (httpStatus !== null && httpStatus !== undefined && httpStatus >= 500)) return 'network'
  if (text && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|fetch failed|getaddrinfo/i.test(text)) return 'network'
  return 'other'
}

/** Build a block from a rejected rate-limit event. Returns null when the event does not reject. */
export function blockFromRateLimitEvent(info: RateLimitPayload, now: number): QuotaBlock | null {
  if (info.status !== 'rejected') return null
  const limitKind = toLimitKind(info.rateLimitType)
  return {
    reason: 'subscription_limit',
    limitKind,
    resetsAt: normaliseEpoch(info.resetsAt),
    detectedAt: now,
    message: `${LIMIT_LABELS[limitKind]} atteinte.`,
    source: 'rate_limit_event'
  }
}

/**
 * Build a block from an error text. The reset time is taken from the most recent rejected
 * window we know about (reliable source), never parsed from free text.
 */
export function blockFromErrorText(text: string, category: 'usage_limit' | 'api_rate_limit', knownWindows: SubscriptionWindow[], now: number): QuotaBlock {
  const rejected = knownWindows
    .filter((window) => window.status === 'rejected' && window.resetsAt !== null && window.resetsAt > now)
    .sort((left, right) => (right.resetsAt ?? 0) - (left.resetsAt ?? 0))[0]
  return {
    reason: category === 'usage_limit' ? 'subscription_limit' : 'api_rate_limit',
    limitKind: rejected?.kind ?? (category === 'usage_limit' ? 'unknown_usage_limit' : 'api_rate_limit'),
    resetsAt: rejected?.resetsAt ?? null,
    detectedAt: now,
    message: text.trim().slice(0, 500),
    source: rejected ? rejected.source : 'error_message'
  }
}

/** When two blocks coexist, keep the one that lasts longest (an unknown reset beats a known one). */
export function combineBlocks(current: QuotaBlock | null, incoming: QuotaBlock | null): QuotaBlock | null {
  if (!current) return incoming
  if (!incoming) return current
  if (current.resetsAt === null && incoming.resetsAt !== null && incoming.limitKind === current.limitKind) return incoming
  if (current.resetsAt === null) return current
  if (incoming.resetsAt === null) return incoming
  return incoming.resetsAt >= current.resetsAt ? incoming : current
}

export interface BlockEvaluation {
  blocked: boolean
  /** The reset time has passed (by the clock). This does NOT prove the quota is restored. */
  resetTimeReached: boolean
  millisecondsRemaining: number | null
}

export function evaluateBlock(block: QuotaBlock | null, now: number): BlockEvaluation {
  if (!block) return { blocked: false, resetTimeReached: false, millisecondsRemaining: null }
  if (block.resetsAt === null) return { blocked: true, resetTimeReached: false, millisecondsRemaining: null }
  const remaining = block.resetsAt - now
  if (remaining <= 0) return { blocked: false, resetTimeReached: true, millisecondsRemaining: 0 }
  return { blocked: true, resetTimeReached: false, millisecondsRemaining: remaining }
}

/**
 * Delay before the next automatic usage check while blocked.
 *  - known reset: check shortly after the reset (5 s margin)
 *  - unknown reset: poll at a reasonable fixed interval, never in a tight loop
 */
export function nextCheckDelay(block: QuotaBlock | null, now: number, pollIntervalMs: number): number | null {
  if (!block) return null
  if (block.resetsAt === null) return pollIntervalMs
  return Math.max(1_000, block.resetsAt - now + 5_000)
}

/**
 * After a usage API check, decide whether a block can be lifted.
 * Only lifts when the official data shows the relevant window is below 100 %
 * or its reset time has passed.
 */
export function shouldLiftBlockAfterCheck(block: QuotaBlock, windows: SubscriptionWindow[], now: number): boolean {
  if (block.reason === 'api_rate_limit') return block.resetsAt !== null && block.resetsAt <= now
  const relevant = windows.find((window) => window.kind === block.limitKind && window.source === 'usage_api' && window.observedAt >= block.detectedAt)
  if (relevant) {
    if (relevant.utilizationPercent !== null && relevant.utilizationPercent < 100) return true
    if (relevant.resetsAt !== null && relevant.resetsAt <= now) return true
    return false
  }
  if (block.limitKind === 'unknown_usage_limit') {
    const anyFresh = windows.filter((window) => window.source === 'usage_api' && window.observedAt >= block.detectedAt)
    return anyFresh.length > 0 && anyFresh.every((window) => window.utilizationPercent !== null && window.utilizationPercent < 100)
  }
  return false
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number): string => value.toString().padStart(2, '0')
  if (days > 0) return `${days} j ${pad(hours)} h ${pad(minutes)} min`
  if (hours > 0) return `${hours} h ${pad(minutes)} min ${pad(seconds)} s`
  return `${minutes} min ${pad(seconds)} s`
}

export function emptyQuotaState(): QuotaState {
  return { block: null, windows: [], rateLimitsAvailable: null, lastUsageCheckAt: null, nextAutomaticCheckAt: null }
}

export function statusLabel(status: LimitStatus | null): string {
  switch (status) {
    case 'allowed':
      return 'Disponible'
    case 'allowed_warning':
      return 'Proche de la limite'
    case 'rejected':
      return 'Limite atteinte'
    default:
      return 'Non communiqué'
  }
}
