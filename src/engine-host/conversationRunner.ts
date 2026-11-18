/**
 * One live Claude Code session driven through the official Agent SDK in streaming-input mode.
 * The runner never fabricates assistant output: every event it emits is derived from an SDK message.
 */
import { randomUUID } from 'node:crypto'
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AssistantBlock, EffortLevel, MessageImage, PermissionModeOption, RunnerState } from '../shared/domain'
import { extensionSdkOptions, type EngineEvent, type RewindResult, type StartRunnerCommand, type TurnResultPayload } from '../shared/engineProtocol'
import { stringifyToolResultContent, toAssistantBlocks } from '../shared/timeline'
import { MessageQueue } from './messageQueue'

export type QueryFactory = (parameters: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query

export interface RunnerDependencies {
  queryFactory: QueryFactory
  emit: (event: EngineEvent) => void
  /** Optional custom spawner (used to track child PIDs for orphan cleanup). */
  spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess']
  environment?: Record<string, string | undefined>
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void
  toolUseId: string
}

const SYNTHETIC_MODEL = '<synthetic>'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface StreamUsage {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export class ConversationRunner {
  readonly conversationId: string
  private readonly inputQueue = new MessageQueue<SDKUserMessage>()
  private readonly abortController = new AbortController()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly accumulatedBlocks = new Map<string, AssistantBlock[]>()
  private activeQuery: Query | null = null
  private sessionId: string | null
  private currentState: RunnerState = 'idle'
  private consumePromise: Promise<void> | null = null
  private lastModel: string | null

  constructor(
    private readonly command: StartRunnerCommand,
    private readonly dependencies: RunnerDependencies
  ) {
    this.conversationId = command.conversationId
    this.sessionId = command.resumeSessionId
    this.lastModel = command.model
  }

  get state(): RunnerState {
    return this.currentState
  }

  get query(): Query | null {
    return this.activeQuery
  }

  get claudeSessionId(): string | null {
    return this.sessionId
  }

  get isBusy(): boolean {
    return this.currentState === 'running' || this.currentState === 'interrupting' || this.currentState === 'starting'
  }

  pendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()]
  }

  buildOptions(): Options {
    const canUseTool: CanUseTool = (toolName, input, context) => this.requestPermission(toolName, input, context)
    const options: Options = {
      cwd: this.command.workingDirectory,
      pathToClaudeCodeExecutable: this.command.executablePath,
      permissionMode: this.command.permissionMode,
      canUseTool,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      abortController: this.abortController,
      stderr: (data: string) => this.dependencies.emit({ type: 'log', level: 'debug', message: `[claude stderr] ${this.conversationId}`, details: data.slice(0, 4000) })
    }
    // "Tout autoriser" is passed only when the user chose it for this session (confirmed in the UI).
    if (this.command.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true
    Object.assign(options, extensionSdkOptions(this.command.extensions))
    if (this.command.allowedTools && this.command.allowedTools.length > 0) options.allowedTools = [...this.command.allowedTools]
    if (this.command.model) options.model = this.command.model
    if (this.command.effort) options.effort = this.command.effort
    // Backups of the files Claude changes, so a turn can be undone (Claude Code's rewind).
    options.enableFileCheckpointing = true
    if (this.command.resumeSessionId) options.resume = this.command.resumeSessionId
    if (this.dependencies.spawnClaudeCodeProcess) options.spawnClaudeCodeProcess = this.dependencies.spawnClaudeCodeProcess
    if (this.dependencies.environment) options.env = this.dependencies.environment
    return options
  }

  start(): void {
    if (this.activeQuery) return
    this.setState('starting')
    try {
      this.activeQuery = this.dependencies.queryFactory({ prompt: this.inputQueue, options: this.buildOptions() })
    } catch (error) {
      this.setState('error', `Impossible de démarrer Claude Code : ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    this.setState('ready')
    this.consumePromise = this.consume()
  }

  send(text: string, clientMessageId: string, images: MessageImage[] = []): void {
    if (!this.activeQuery) this.start()
    if (this.inputQueue.isEnded) throw new Error('Cette session est fermée.')
    // Images first, then the text: the order Claude Code itself sends a pasted screenshot in.
    const content = images.length > 0 ? [...images.map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } })), { type: 'text' as const, text }] : text
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: (isUuid(clientMessageId) ? clientMessageId : randomUUID()) as SDKUserMessage['uuid']
    }
    this.setState('running')
    this.inputQueue.push(message)
  }

  async interrupt(): Promise<void> {
    if (!this.activeQuery) return
    this.interruptRequested = true
    this.setState('interrupting')
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'Génération interrompue par l’utilisateur.', interrupt: true, toolUseID: pending.toolUseId })
      this.dependencies.emit({ type: 'permission_cancelled', conversationId: this.conversationId, requestId })
    }
    this.pendingPermissions.clear()
    try {
      await this.activeQuery.interrupt()
    } catch (error) {
      this.dependencies.emit({ type: 'log', level: 'warn', message: 'Échec de l’interruption', details: error instanceof Error ? error.message : String(error) })
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.lastModel = model
    if (this.activeQuery) await this.activeQuery.setModel(model ?? undefined)
  }

  /** Restores the files Claude changed to their state before the user message `userMessageId`. */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    if (!this.activeQuery) this.start()
    const query = this.activeQuery
    if (!query) return { canRewind: false, error: 'Session indisponible.' }
    const result = await query.rewindFiles(userMessageId, { dryRun })
    return { canRewind: result.canRewind, ...(result.error ? { error: result.error } : {}), ...(result.filesChanged ? { filesChanged: result.filesChanged } : {}), ...(typeof result.insertions === 'number' ? { insertions: result.insertions } : {}), ...(typeof result.deletions === 'number' ? { deletions: result.deletions } : {}) }
  }

  /** Changes the thinking effort of the running session (null: back to the model's default). */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (this.activeQuery) await this.activeQuery.applyFlagSettings({ effortLevel: effort })
  }

  async setPermissionMode(mode: PermissionModeOption): Promise<void> {
    if (this.activeQuery) await this.activeQuery.setPermissionMode(mode)
  }

  resolvePermission(requestId: string, allow: boolean, message: string | undefined, input: Record<string, unknown> | undefined): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return false
    this.pendingPermissions.delete(requestId)
    if (allow) pending.resolve({ behavior: 'allow', updatedInput: input, toolUseID: pending.toolUseId })
    else pending.resolve({ behavior: 'deny', message: message?.trim() || 'L’utilisateur a refusé cette action.', toolUseID: pending.toolUseId })
    return true
  }

  close(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'Session fermée.', interrupt: true, toolUseID: pending.toolUseId })
      this.dependencies.emit({ type: 'permission_cancelled', conversationId: this.conversationId, requestId })
    }
    this.pendingPermissions.clear()
    this.inputQueue.end()
    try {
      this.activeQuery?.close()
    } catch {
      // the process may already be gone
    }
    this.setState('closed')
  }

  async waitForCompletion(): Promise<void> {
    await this.consumePromise
  }

  /** Inputs given to canUseTool, kept so that "allow" re-sends the exact same input. */
  private readonly permissionInputs = new Map<string, Record<string, unknown>>()

  inputForRequest(requestId: string): Record<string, unknown> | undefined {
    return this.permissionInputs.get(requestId)
  }

  private requestPermission(toolName: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const requestId = context.requestId || randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      const finish = (result: PermissionResult): void => {
        this.permissionInputs.delete(requestId)
        resolve(result)
      }
      this.pendingPermissions.set(requestId, { resolve: finish, toolUseId: context.toolUseID })
      this.permissionInputs.set(requestId, input)
      context.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingPermissions.delete(requestId)) {
            this.dependencies.emit({ type: 'permission_cancelled', conversationId: this.conversationId, requestId })
            finish({ behavior: 'deny', message: 'Demande annulée.', toolUseID: context.toolUseID })
          }
        },
        { once: true }
      )
      this.dependencies.emit({
        type: 'permission_request',
        conversationId: this.conversationId,
        requestId,
        toolName,
        toolUseId: context.toolUseID,
        input,
        title: context.title,
        description: context.description,
        decisionReason: context.decisionReason,
        blockedPath: context.blockedPath,
        displayName: context.displayName
      })
    })
  }

  private setState(state: RunnerState, message?: string): void {
    this.currentState = state
    this.dependencies.emit({ type: 'runner_state', conversationId: this.conversationId, state, message })
  }

  private async consume(): Promise<void> {
    const activeQuery = this.activeQuery
    if (!activeQuery) return
    try {
      for await (const message of activeQuery) this.handleMessage(message)
      if (this.currentState !== 'closed') this.setState('closed')
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const aborted = this.abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      if (aborted || this.currentState === 'closed') this.setState('closed')
      else this.setState('error', `Le moteur Claude Code s’est arrêté : ${text}`)
    } finally {
      this.inputQueue.end()
    }
  }

  handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        this.handleSystemMessage(message as unknown as Record<string, unknown>)
        return
      case 'stream_event':
        this.handleStreamEvent(message.event as unknown, message.parent_tool_use_id)
        return
      case 'assistant': {
        const apiMessage = message.message as unknown as { id?: string; content?: unknown; model?: string }
        const messageId = apiMessage.id ?? message.uuid
        const blocks = [...(this.accumulatedBlocks.get(messageId) ?? []), ...toAssistantBlocks(apiMessage.content)]
        this.accumulatedBlocks.set(messageId, blocks)
        // "<synthetic>" marks a local reply (e.g. a mod's slash command), not a model.
        const model = apiMessage.model && apiMessage.model !== SYNTHETIC_MODEL ? apiMessage.model : null
        if (model) this.lastModel = model
        this.dependencies.emit({ type: 'assistant_message', conversationId: this.conversationId, messageId, blocks, model, error: message.error ?? null, parentToolUseId: message.parent_tool_use_id })
        return
      }
      case 'user': {
        const content = (message.message as { content?: unknown }).content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              this.dependencies.emit({ type: 'tool_result', conversationId: this.conversationId, toolUseId: block.tool_use_id, content: stringifyToolResultContent(block.content).slice(0, 200_000), isError: block.is_error === true })
            }
          }
        }
        return
      }
      case 'result': {
        this.accumulatedBlocks.clear()
        const result = message as unknown as Record<string, unknown> & { usage?: Record<string, number>; modelUsage?: Record<string, unknown> }
        const usage = result.usage ?? {}
        const payload: TurnResultPayload = {
          subtype: String(result.subtype),
          isError: result.is_error === true,
          durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : 0,
          totalCostUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          errors: Array.isArray(result.errors) ? (result.errors as unknown[]).map(String) : [],
          resultText: typeof result.result === 'string' ? result.result : null,
          apiErrorStatus: typeof result.api_error_status === 'number' ? result.api_error_status : null,
          model: this.lastModel,
          ...(this.interruptRequested ? { interrupted: true } : {})
        }
        this.interruptRequested = false
        if (typeof message.session_id === 'string' && message.session_id) this.sessionId = message.session_id
        this.dependencies.emit({ type: 'turn_result', conversationId: this.conversationId, sessionId: this.sessionId ?? message.session_id, result: payload })
        if (this.currentState !== 'closed') this.setState('idle')
        return
      }
      case 'rate_limit_event': {
        const info = message.rate_limit_info
        this.dependencies.emit({
          type: 'rate_limit',
          conversationId: this.conversationId,
          info: { status: info.status, resetsAt: info.resetsAt, rateLimitType: info.rateLimitType, utilization: info.utilization, overageStatus: info.overageStatus, overageResetsAt: info.overageResetsAt, isUsingOverage: info.isUsingOverage }
        })
        return
      }
      case 'auth_status':
        this.dependencies.emit({ type: 'auth_status', conversationId: this.conversationId, isAuthenticating: message.isAuthenticating, output: message.output, error: message.error })
        return
      default:
        return
    }
  }

  private handleSystemMessage(message: Record<string, unknown>): void {
    const subtype = message.subtype
    if (subtype === 'init') {
      const sessionId = String(message.session_id ?? '')
      this.sessionId = sessionId || this.sessionId
      if (typeof message.model === 'string') this.lastModel = message.model
      this.dependencies.emit({
        type: 'session_init',
        conversationId: this.conversationId,
        sessionId,
        model: String(message.model ?? ''),
        workingDirectory: String(message.cwd ?? this.command.workingDirectory),
        tools: Array.isArray(message.tools) ? (message.tools as unknown[]).map(String) : [],
        permissionMode: String(message.permissionMode ?? this.command.permissionMode),
        claudeCodeVersion: String(message.claude_code_version ?? '')
      })
    } else if (subtype === 'api_retry') {
      this.dependencies.emit({
        type: 'api_retry',
        conversationId: this.conversationId,
        attempt: Number(message.attempt ?? 0),
        maxRetries: Number(message.max_retries ?? 0),
        retryDelayMs: Number(message.retry_delay_ms ?? 0),
        errorStatus: typeof message.error_status === 'number' ? message.error_status : null,
        error: String(message.error ?? 'unknown')
      })
    } else if (subtype === 'compact_boundary') {
      this.dependencies.emit({ type: 'engine_notice', conversationId: this.conversationId, tone: 'info', text: 'Claude Code a compacté le contexte de la conversation.' })
    } else if (subtype === 'ui_status' || subtype === 'ui_toast' || subtype === 'ui_log' || subtype === 'ui_panes') {
      this.handleModMessage(subtype, message)
    }
  }

  /**
   * Messages Claude Code sends for the mods (plugins with a hooks module) when no terminal draws them.
   * Not part of the SDK's typed messages yet, so every field is checked before use.
   */
  private handleModMessage(subtype: 'ui_status' | 'ui_toast' | 'ui_log' | 'ui_panes', message: Record<string, unknown>): void {
    const plugin = typeof message.plugin === 'string' ? message.plugin.slice(0, 100) : 'mod'
    if (subtype === 'ui_status') {
      const text = typeof message.text === 'string' && message.text.trim() ? message.text.slice(0, 300) : null
      this.dependencies.emit({ type: 'mod_status', conversationId: this.conversationId, plugin, text })
    } else if (subtype === 'ui_toast') {
      if (typeof message.text === 'string' && message.text.trim()) this.dependencies.emit({ type: 'mod_toast', conversationId: this.conversationId, plugin, text: message.text.slice(0, 1000) })
    } else if (subtype === 'ui_log') {
      if (typeof message.text === 'string') this.dependencies.emit({ type: 'log', level: 'info', message: `[mod ${plugin}]`, details: message.text.slice(0, 4000) })
    } else {
      const panes = Array.isArray(message.panes)
        ? message.panes.filter(isRecord).map((pane) => ({ id: String(pane.id ?? ''), title: String(pane.title ?? pane.id ?? ''), plugin: String(pane.plugin ?? '') })).filter((pane) => pane.id)
        : []
      this.dependencies.emit({ type: 'mod_panes', conversationId: this.conversationId, panes })
    }
  }

  private handleStreamEvent(rawEvent: unknown, parentToolUseId: string | null): void {
    if (!isRecord(rawEvent)) return
    if (rawEvent.type === 'message_start' && isRecord(rawEvent.message)) {
      this.trackUsageStart(rawEvent.message, parentToolUseId)
      if (typeof rawEvent.message.id === 'string') this.currentStreamKey = rawEvent.message.id
      return
    }
    if (rawEvent.type === 'message_delta') {
      this.trackUsageDelta(rawEvent.usage, parentToolUseId)
      return
    }
    if (rawEvent.type === 'content_block_delta' && isRecord(rawEvent.delta) && this.currentStreamKey) {
      const blockIndex = typeof rawEvent.index === 'number' ? rawEvent.index : 0
      const delta = rawEvent.delta
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.dependencies.emit({ type: 'text_delta', conversationId: this.conversationId, streamKey: this.currentStreamKey, blockIndex, text: delta.text, thinking: false })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.dependencies.emit({ type: 'text_delta', conversationId: this.conversationId, streamKey: this.currentStreamKey, blockIndex, text: delta.thinking, thinking: true })
      }
    }
  }

  private currentStreamKey: string | null = null
  /** Set by interrupt(), cleared once the stopped turn has reported its result. */
  private interruptRequested = false
  /** Per stream (main conversation or a subagent): what was already reported of the current response. */
  private readonly streamUsage = new Map<string, StreamUsage>()

  private trackUsageStart(message: Record<string, unknown>, parentToolUseId: string | null): void {
    const model = typeof message.model === 'string' && message.model !== SYNTHETIC_MODEL ? message.model : null
    const reported: StreamUsage = { model, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    this.streamUsage.set(parentToolUseId ?? '', reported)
    if (isRecord(message.usage)) this.reportUsage(reported, message.usage, parentToolUseId)
  }

  private trackUsageDelta(rawUsage: unknown, parentToolUseId: string | null): void {
    const reported = this.streamUsage.get(parentToolUseId ?? '')
    if (reported && isRecord(rawUsage)) this.reportUsage(reported, rawUsage, parentToolUseId)
  }

  /** Usage fields are running totals for the response: emits only what grew since the last report. */
  private reportUsage(reported: StreamUsage, usage: Record<string, unknown>, parentToolUseId: string | null): void {
    const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
    const next = {
      inputTokens: Math.max(reported.inputTokens, count(usage.input_tokens)),
      outputTokens: Math.max(reported.outputTokens, count(usage.output_tokens)),
      cacheReadInputTokens: Math.max(reported.cacheReadInputTokens, count(usage.cache_read_input_tokens)),
      cacheCreationInputTokens: Math.max(reported.cacheCreationInputTokens, count(usage.cache_creation_input_tokens))
    }
    const increment = {
      inputTokens: next.inputTokens - reported.inputTokens,
      outputTokens: next.outputTokens - reported.outputTokens,
      cacheReadInputTokens: next.cacheReadInputTokens - reported.cacheReadInputTokens,
      cacheCreationInputTokens: next.cacheCreationInputTokens - reported.cacheCreationInputTokens
    }
    Object.assign(reported, next)
    if (increment.inputTokens + increment.outputTokens + increment.cacheReadInputTokens + increment.cacheCreationInputTokens === 0) return
    this.dependencies.emit({ type: 'token_usage', conversationId: this.conversationId, model: reported.model, ...increment, subagent: parentToolUseId !== null })
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
