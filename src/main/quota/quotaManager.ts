/**
 * Suspends and resumes sending based on limits reported by the official engine.
 * - never retries a refused request by itself
 * - never assumes a reset without data: a known reset time comes from rate_limit_event or the usage API
 * - when the reset time is unknown, checks the official usage API at a slow, fixed interval
 */
import { APP_CONFIG } from '../../shared/appConfig'
import type { QuotaBlock, QuotaEventRecord, QuotaState, SubscriptionWindow } from '../../shared/domain'
import type { RateLimitPayload, TurnResultPayload, UsageApiResult } from '../../shared/engineProtocol'
import {
  LIMIT_LABELS,
  blockFromErrorText,
  blockFromRateLimitEvent,
  classifyEngineError,
  combineBlocks,
  emptyQuotaState,
  evaluateBlock,
  formatDuration,
  mergeWindows,
  nextCheckDelay,
  shouldLiftBlockAfterCheck,
  windowFromRateLimitEvent,
  windowsFromUsageApi
} from '../../shared/quota'

export interface QuotaManagerDependencies {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  notify: (title: string, body: string) => void
  recordEvent: (event: Omit<QuotaEventRecord, 'id' | 'createdAt'>) => void
  readUsage: () => Promise<UsageApiResult>
  onStateChange: (state: QuotaState) => void
  isSubscriptionAccount: () => boolean
  pollIntervalMs?: number
}

export type SendDecision = { allowed: true } | { allowed: false; reason: string }

export class QuotaManager {
  private state: QuotaState = emptyQuotaState()
  private timer: unknown = null
  private checking: Promise<QuotaState> | null = null

  constructor(private readonly dependencies: QuotaManagerDependencies) {}

  get snapshot(): QuotaState {
    return this.state
  }

  canSend(): SendDecision {
    const evaluation = evaluateBlock(this.state.block, this.dependencies.now())
    if (evaluation.resetTimeReached) this.liftBlock('reset_time_reached')
    if (!evaluation.blocked) return { allowed: true }
    const block = this.state.block
    if (!block) return { allowed: true }
    const when = evaluation.millisecondsRemaining !== null ? `Reprise possible dans ${formatDuration(evaluation.millisecondsRemaining)} (${new Date(block.resetsAt ?? 0).toLocaleString('fr-FR')}).` : 'Heure de réinitialisation non communiquée par Claude Code.'
    return { allowed: false, reason: `${block.message} ${when}` }
  }

  handleRateLimit(info: RateLimitPayload): void {
    const now = this.dependencies.now()
    const window = windowFromRateLimitEvent(info, now)
    const windows = mergeWindows(this.state.windows, [window])
    const block = blockFromRateLimitEvent(info, now)
    if (block) {
      this.applyBlock(block, windows)
    } else {
      if (info.status === 'allowed_warning') {
        this.dependencies.recordEvent({ eventType: 'warning', limitKind: window.kind, status: info.status, utilizationPercent: window.utilizationPercent, resetsAt: window.resetsAt, message: 'Proche de la limite' })
      }
      this.update({ ...this.state, windows })
    }
  }

  /** Inspect a finished turn for limit errors. Returns the error category for the caller's UI. */
  handleTurnResult(result: TurnResultPayload): ReturnType<typeof classifyEngineError> | null {
    // A turn the user stopped is not an engine error.
    if (!result.isError || result.interrupted) return null
    const text = [result.resultText, ...result.errors].filter(Boolean).join('\n')
    const category = classifyEngineError({ text, httpStatus: result.apiErrorStatus, isSubscription: this.dependencies.isSubscriptionAccount() })
    if (category === 'usage_limit' || category === 'api_rate_limit') this.applyBlock(blockFromErrorText(text || 'Limite atteinte.', category, this.state.windows, this.dependencies.now()), this.state.windows)
    return category
  }

  handleAssistantError(assistantError: string, text: string): ReturnType<typeof classifyEngineError> {
    const category = classifyEngineError({ assistantError, text, isSubscription: this.dependencies.isSubscriptionAccount() })
    if (category === 'usage_limit' || category === 'api_rate_limit') this.applyBlock(blockFromErrorText(text || 'Limite atteinte.', category, this.state.windows, this.dependencies.now()), this.state.windows)
    return category
  }

  private applyBlock(incoming: QuotaBlock, windows: SubscriptionWindow[]): void {
    const previous = this.state.block
    const block = combineBlocks(previous, incoming)
    const isNew = !previous || previous.resetsAt !== block?.resetsAt || previous.limitKind !== block?.limitKind
    this.update({ ...this.state, windows, block })
    if (isNew && block) {
      this.dependencies.recordEvent({ eventType: 'limit_detected', limitKind: block.limitKind, status: 'rejected', utilizationPercent: null, resetsAt: block.resetsAt, message: block.message })
      const body = block.resetsAt ? `Envois suspendus jusqu’à ${new Date(block.resetsAt).toLocaleString('fr-FR')}. Vos conversations restent consultables.` : 'Heure de réinitialisation inconnue. Vérification périodique via l’interface officielle.'
      this.dependencies.notify(`${LIMIT_LABELS[block.limitKind]} atteinte`, body)
    }
    this.scheduleNext()
  }

  private liftBlock(eventType: 'reset_time_reached' | 'reset_confirmed' | 'cleared_manually'): void {
    const block = this.state.block
    if (!block) return
    this.dependencies.recordEvent({ eventType, limitKind: block.limitKind, status: null, utilizationPercent: null, resetsAt: block.resetsAt, message: null })
    this.update({ ...this.state, block: null, nextAutomaticCheckAt: null })
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
    if (eventType === 'reset_time_reached') {
      this.dependencies.notify('Envois réactivés', 'L’heure de réinitialisation communiquée par Claude Code est passée. Vous pouvez de nouveau envoyer des messages.')
      // Confirm with official data when possible; failures are non-fatal.
      void this.checkNow().catch(() => undefined)
    } else if (eventType === 'reset_confirmed') {
      this.dependencies.notify('Quota disponible', 'Claude Code indique que la limite n’est plus atteinte. Les envois sont réactivés.')
    }
  }

  clearManually(): QuotaState {
    this.liftBlock('cleared_manually')
    return this.state
  }

  private scheduleNext(): void {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
    const now = this.dependencies.now()
    const delay = nextCheckDelay(this.state.block, now, this.dependencies.pollIntervalMs ?? APP_CONFIG.quotaPollIntervalMs)
    if (delay === null) {
      if (this.state.nextAutomaticCheckAt !== null) this.update({ ...this.state, nextAutomaticCheckAt: null })
      return
    }
    this.update({ ...this.state, nextAutomaticCheckAt: now + delay })
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      this.onTimer()
    }, delay)
  }

  private onTimer(): void {
    const evaluation = evaluateBlock(this.state.block, this.dependencies.now())
    if (evaluation.resetTimeReached) {
      this.liftBlock('reset_time_reached')
      return
    }
    if (this.state.block) {
      this.checkNow()
        .catch(() => undefined)
        .finally(() => {
          if (this.state.block) this.scheduleNext()
        })
    }
  }

  /** Reads the official usage data. Never sends a model request. */
  checkNow(): Promise<QuotaState> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      const now = this.dependencies.now()
      try {
        const usage = await this.dependencies.readUsage()
        const windows = mergeWindows(this.state.windows, windowsFromUsageApi(usage, now))
        this.update({ ...this.state, windows, rateLimitsAvailable: usage.rateLimitsAvailable, usageApiError: undefined, lastUsageCheckAt: now })
        this.dependencies.recordEvent({ eventType: 'check', limitKind: null, status: usage.rateLimitsAvailable ? 'available' : 'not_available', utilizationPercent: null, resetsAt: null, message: null })
        const block = this.state.block
        if (block) {
          // Refresh an unknown reset time from the usage API when it reports one for the blocked window.
          const matching = windows.find((window) => window.kind === block.limitKind && window.resetsAt !== null)
          if (block.resetsAt === null && matching?.resetsAt && matching.utilizationPercent !== null && matching.utilizationPercent >= 100) {
            this.update({ ...this.state, block: { ...block, resetsAt: matching.resetsAt, source: 'usage_api' } })
            this.scheduleNext()
          } else if (shouldLiftBlockAfterCheck(block, windows, now)) {
            this.liftBlock('reset_confirmed')
          }
        }
      } catch (error) {
        this.update({ ...this.state, usageApiError: error instanceof Error ? error.message : String(error), lastUsageCheckAt: now })
      }
      return this.state
    })().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private update(state: QuotaState): void {
    this.state = state
    this.dependencies.onStateChange(state)
  }

  dispose(): void {
    if (this.timer) this.dependencies.clearTimer(this.timer)
    this.timer = null
  }
}
