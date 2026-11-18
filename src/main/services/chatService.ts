/**
 * Orchestrates conversations and the engine: sending, interrupting, permissions,
 * persisting session ids, recording usage and feeding the quota manager.
 */
import type { AppPreferences, ClaudeInstallation, Conversation, EffortLevel, MessageImage, PermissionModeOption, PermissionRequest, RunnerExtensions } from '../../shared/domain'
import type { EngineEvent, HostCommand, HostRpcMethod, HostRpcRequest, HostRpcResultMap, RewindResult } from '../../shared/engineProtocol'
import type { ConversationHistory, PushEvents } from '../../shared/ipcContract'
import type { Repositories } from '../database/repositories'
import type { QuotaManager } from '../quota/quotaManager'
import type { ScopedLogger } from './logger'
import { directoryExists } from './pathGuard'

export interface EngineLike {
  send(command: HostCommand): Promise<void>
  rpc<Method extends HostRpcMethod>(request: Extract<HostRpcRequest, { method: Method }>, timeoutMs?: number): Promise<HostRpcResultMap[Method]>
  isRunnerActive(conversationId: string): boolean
}

export interface ChatServiceDependencies {
  repositories: Repositories
  engine: EngineLike
  quota: QuotaManager
  getInstallation: () => ClaudeInstallation
  getPreferences: () => AppPreferences
  push: <Channel extends keyof PushEvents>(channel: Channel, payload: PushEvents[Channel]) => void
  notify: (title: string, body: string, onlyWhenUnfocused: boolean) => void
  log: ScopedLogger
  /** Aether's plugin / mod / skill choices for a new session in this folder. */
  resolveExtensions?: (workingDirectory: string) => Promise<{ extensions: RunnerExtensions; warning?: string }>
  /** Pre-authorisations of a running Codex pilot (permission mode, allow rules), chosen by the user. */
  getLaunchOverrides?: (conversationId: string) => { permissionMode?: PermissionModeOption; allowedTools?: string[] } | null
}

export const DEFAULT_CONVERSATION_TITLE = 'Nouvelle conversation'

export function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
  const compact = firstLine.replace(/\s+/g, ' ')
  if (compact.length === 0) return DEFAULT_CONVERSATION_TITLE
  return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact
}

export class ChatService {
  private readonly pendingPermissions = new Map<string, PermissionRequest>()
  /**
   * `total_cost_usd` is cumulative per query. A resumed session's first result already includes
   * earlier turns, so its per-turn cost cannot be isolated and is stored as unknown (null).
   */
  /** Runners launched in "tout autoriser": only those can switch to it without restarting. */
  private readonly launchedBypass = new Set<string>()
  /** Switched to "tout autoriser" while Claude was answering: the session restarts once the turn ends. */
  private readonly restartAfterTurn = new Set<string>()
  private readonly busyRunners = new Set<string>()
  private readonly costTracking = new Map<string, { resumed: boolean; lastCumulativeCost: number | null }>()

  perTurnCost(conversationId: string, cumulativeCost: number | null): number | null {
    if (cumulativeCost === null) return null
    const tracking = this.costTracking.get(conversationId) ?? { resumed: true, lastCumulativeCost: null }
    let perTurn: number | null
    if (tracking.lastCumulativeCost === null) perTurn = tracking.resumed ? null : cumulativeCost
    else perTurn = cumulativeCost >= tracking.lastCumulativeCost ? cumulativeCost - tracking.lastCumulativeCost : null
    this.costTracking.set(conversationId, { resumed: tracking.resumed, lastCumulativeCost: cumulativeCost })
    return perTurn
  }

  constructor(private readonly dependencies: ChatServiceDependencies) {}

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.dependencies.repositories.conversations.findById(conversationId)
    if (!conversation) throw new Error('Conversation introuvable.')
    return conversation
  }

  listPendingPermissions(): PermissionRequest[] {
    return [...this.pendingPermissions.values()].sort((left, right) => left.createdAt - right.createdAt)
  }

  async send(conversationId: string, text: string, clientMessageId: string, images: MessageImage[] = []): Promise<{ accepted: boolean; reason?: string }> {
    const decision = this.dependencies.quota.canSend()
    if (!decision.allowed) return { accepted: false, reason: decision.reason }
    const installation = this.dependencies.getInstallation()
    if (!installation.found || !installation.executablePath) return { accepted: false, reason: 'Claude Code n’est pas installé ou introuvable. Consultez Paramètres › Moteur.' }
    const conversation = this.requireConversation(conversationId)
    if (!directoryExists(conversation.workingDirectory)) return { accepted: false, reason: `Le dossier de travail n’existe plus : ${conversation.workingDirectory}` }
    await this.ensureRunner(conversation, installation.executablePath)
    await this.dependencies.engine.send({ type: 'send_message', conversationId, text, clientMessageId, ...(images.length > 0 ? { images } : {}) })

    if (conversation.title === DEFAULT_CONVERSATION_TITLE) this.dependencies.repositories.conversations.rename(conversationId, deriveTitle(text))
    else this.dependencies.repositories.conversations.touch(conversationId)
    const refreshed = this.dependencies.repositories.conversations.findById(conversationId)
    if (refreshed) this.dependencies.push('conversations:updated', refreshed)
    return { accepted: true }
  }

  /** Restores the files Claude changed to their state before a message of the user (dry run: only says what would change). */
  async rewindFiles(conversationId: string, userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    const installation = this.dependencies.getInstallation()
    if (!installation.found || !installation.executablePath) return { canRewind: false, error: 'Claude Code est introuvable.' }
    const conversation = this.requireConversation(conversationId)
    if (!directoryExists(conversation.workingDirectory)) return { canRewind: false, error: `Le dossier de travail n’existe plus : ${conversation.workingDirectory}` }
    if (this.busyRunners.has(conversationId)) return { canRewind: false, error: 'Claude travaille encore : attendez la fin du tour ou arrêtez-le.' }
    await this.ensureRunner(conversation, installation.executablePath)
    const result = await this.dependencies.engine.rpc({ method: 'rewind_files', conversationId, userMessageId, dryRun }, 60_000)
    if (!dryRun && result.canRewind) this.dependencies.log.info(`Fichiers restaurés (${result.filesChanged?.length ?? 0})`, { conversationId })
    return result
  }

  /** Starts Claude Code for a conversation when it is not running yet. */
  private async ensureRunner(conversation: Conversation, executablePath: string): Promise<void> {
    const conversationId = conversation.id
    if (!this.dependencies.engine.isRunnerActive(conversationId)) {
      const preferences = this.dependencies.getPreferences()
      const launch = this.dependencies.resolveExtensions ? await this.dependencies.resolveExtensions(conversation.workingDirectory) : null
      const overrides = this.dependencies.getLaunchOverrides?.(conversationId) ?? null
      if (launch?.warning) this.handleEngineEvent({ type: 'engine_notice', conversationId, tone: 'warning', text: launch.warning })
      const permissionMode = overrides?.permissionMode && conversation.permissionMode !== 'bypassPermissions' ? overrides.permissionMode : conversation.permissionMode
      if (permissionMode === 'bypassPermissions') this.launchedBypass.add(conversationId)
      else this.launchedBypass.delete(conversationId)
      await this.dependencies.engine.send({
        type: 'start_runner',
        conversationId,
        executablePath,
        workingDirectory: conversation.workingDirectory,
        model: conversation.model ?? preferences.defaultModel,
        // A running pilot sets the mode the user chose in its form; otherwise the conversation's own mode.
        permissionMode,
        resumeSessionId: conversation.claudeSessionId,
        ...(launch ? { extensions: launch.extensions } : {}),
        ...(overrides?.allowedTools?.length ? { allowedTools: overrides.allowedTools } : {}),
        ...(this.effortFor(conversationId) ? { effort: this.effortFor(conversationId) as EffortLevel } : {})
      })
      if (conversation.claudeSessionId) this.dependencies.repositories.sessionMappings.record(conversationId, conversation.claudeSessionId, 'resume', conversation.workingDirectory)
      this.costTracking.set(conversationId, { resumed: conversation.claudeSessionId !== null, lastCumulativeCost: null })
    }
  }

  /** The effort of a conversation: its own choice, else the default one. */
  effortFor(conversationId: string): EffortLevel | null {
    const preferences = this.dependencies.getPreferences()
    return preferences.conversationEfforts?.[conversationId] ?? preferences.defaultEffort ?? null
  }

  /** Sets a conversation's effort (null: back to the default) and applies it to the running session. */
  async setEffort(conversationId: string, effort: EffortLevel | null): Promise<void> {
    this.requireConversation(conversationId)
    if (this.dependencies.engine.isRunnerActive(conversationId)) await this.dependencies.engine.send({ type: 'set_effort', conversationId, effort: effort ?? this.dependencies.getPreferences().defaultEffort ?? null })
  }

  async interrupt(conversationId: string): Promise<void> {
    if (this.dependencies.engine.isRunnerActive(conversationId)) await this.dependencies.engine.send({ type: 'interrupt', conversationId })
    this.dropPermissionsFor(conversationId)
  }

  async decidePermission(requestId: string, allow: boolean, message?: string, answers?: Record<string, string>): Promise<void> {
    const request = this.pendingPermissions.get(requestId)
    if (!request) return
    // Answers only make sense for Claude's questions; never smuggled into another tool's input.
    const questionAnswers = request.toolName === 'AskUserQuestion' && allow && answers && Object.keys(answers).length > 0 ? answers : undefined
    this.pendingPermissions.delete(requestId)
    this.dependencies.push('permissions:pending', this.listPendingPermissions())
    this.dependencies.log.info(`Permission ${allow ? 'accordée' : 'refusée'} : ${request.toolName}`, { conversationId: request.conversationId })
    await this.dependencies.engine.send({ type: 'permission_decision', requestId, allow, message, ...(questionAnswers ? { answers: questionAnswers } : {}) })
  }

  async setModel(conversationId: string, model: string | null): Promise<Conversation> {
    const conversation = this.dependencies.repositories.conversations.setModel(conversationId, model)
    if (this.dependencies.engine.isRunnerActive(conversationId)) await this.dependencies.engine.send({ type: 'set_model', conversationId, model })
    return conversation
  }

  async setPermissionMode(conversationId: string, permissionMode: PermissionModeOption): Promise<Conversation> {
    const conversation = this.dependencies.repositories.conversations.setPermissionMode(conversationId, permissionMode)
    if (!this.dependencies.engine.isRunnerActive(conversationId)) return conversation
    if (permissionMode === 'bypassPermissions' && !this.launchedBypass.has(conversationId)) {
      // Claude Code only enters this mode from a session launched for it: restart (same session, context kept).
      if (this.busyRunners.has(conversationId)) this.restartAfterTurn.add(conversationId)
      else await this.closeRunner(conversationId)
      return conversation
    }
    this.restartAfterTurn.delete(conversationId)
    await this.dependencies.engine.send({ type: 'set_permission_mode', conversationId, permissionMode })
    return conversation
  }

  async closeRunner(conversationId: string): Promise<void> {
    if (this.dependencies.engine.isRunnerActive(conversationId)) await this.dependencies.engine.send({ type: 'close_runner', conversationId })
    this.dropPermissionsFor(conversationId)
  }

  /** Removes the conversation from Aether. The Claude Code transcript is left untouched. */
  async deleteConversation(conversationId: string): Promise<void> {
    await this.closeRunner(conversationId)
    this.dependencies.repositories.conversations.delete(conversationId)
  }

  async history(conversationId: string): Promise<ConversationHistory> {
    const conversation = this.requireConversation(conversationId)
    if (!conversation.claudeSessionId) return { conversation, items: [], source: 'empty' }
    try {
      const items = await this.dependencies.engine.rpc({ method: 'session_history', sessionId: conversation.claudeSessionId, directory: conversation.workingDirectory, limit: 2000 })
      return { conversation, items, source: 'claude-transcript' }
    } catch (error) {
      try {
        // The transcript may live under another project folder (e.g. moved directory): search all projects.
        const items = await this.dependencies.engine.rpc({ method: 'session_history', sessionId: conversation.claudeSessionId, directory: null, limit: 2000 })
        return { conversation, items, source: 'claude-transcript' }
      } catch {
        return { conversation, items: [], source: 'empty', error: `Historique Claude Code illisible : ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }

  private dropPermissionsFor(conversationId: string): void {
    let changed = false
    for (const [requestId, request] of this.pendingPermissions) {
      if (request.conversationId === conversationId) {
        this.pendingPermissions.delete(requestId)
        changed = true
      }
    }
    if (changed) this.dependencies.push('permissions:pending', this.listPendingPermissions())
  }

  handleEngineEvent(event: EngineEvent): void {
    const { repositories } = this.dependencies
    switch (event.type) {
      case 'session_init': {
        const conversation = repositories.conversations.findById(event.conversationId)
        if (conversation && event.sessionId && conversation.claudeSessionId !== event.sessionId) {
          const updated = repositories.conversations.setSessionId(event.conversationId, event.sessionId)
          this.dependencies.push('conversations:updated', updated)
        }
        if (event.sessionId) repositories.sessionMappings.record(event.conversationId, event.sessionId, 'init', event.workingDirectory)
        break
      }
      case 'turn_result': {
        const conversation = repositories.conversations.findById(event.conversationId)
        repositories.usage.record({
          conversationId: event.conversationId,
          claudeSessionId: event.sessionId || conversation?.claudeSessionId || null,
          model: event.result.model,
          inputTokens: event.result.inputTokens,
          outputTokens: event.result.outputTokens,
          cacheReadInputTokens: event.result.cacheReadInputTokens,
          cacheCreationInputTokens: event.result.cacheCreationInputTokens,
          estimatedCostUsd: this.perTurnCost(event.conversationId, event.result.totalCostUsd),
          durationMs: event.result.durationMs,
          isError: event.result.isError
        })
        const category = this.dependencies.quota.handleTurnResult(event.result)
        if (category === 'authentication') this.dependencies.push('app:toast', { tone: 'error', title: 'Authentification requise', body: 'Claude Code signale un problème d’authentification. Reconnectez-vous depuis Paramètres › Authentification.' })
        else if (category === 'network') this.dependencies.push('app:toast', { tone: 'warning', title: 'Problème réseau', body: 'La requête a échoué pour une raison réseau ou serveur. Ce n’est pas une limite de quota.' })
        const preferences = this.dependencies.getPreferences()
        if (preferences.notificationsEnabled && preferences.notifyOnTurnComplete && !event.result.isError) this.dependencies.notify('Réponse terminée', conversation?.title ?? 'Conversation', true)
        break
      }
      case 'rate_limit':
        this.dependencies.quota.handleRateLimit(event.info)
        break
      case 'assistant_message':
        if (event.error) {
          const text = event.blocks
            .filter((block) => block.kind === 'text')
            .map((block) => (block.kind === 'text' ? block.text : ''))
            .join('\n')
          this.dependencies.quota.handleAssistantError(event.error, text)
        }
        break
      case 'permission_request': {
        const request: PermissionRequest = {
          requestId: event.requestId,
          conversationId: event.conversationId,
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          input: event.input,
          title: event.title,
          description: event.description,
          decisionReason: event.decisionReason,
          blockedPath: event.blockedPath,
          displayName: event.displayName,
          createdAt: Date.now()
        }
        this.pendingPermissions.set(event.requestId, request)
        this.dependencies.push('permissions:pending', this.listPendingPermissions())
        if (this.dependencies.getPreferences().notificationsEnabled) this.dependencies.notify('Autorisation requise', `${event.displayName ?? event.toolName} attend votre décision.`, true)
        break
      }
      case 'permission_cancelled':
        if (this.pendingPermissions.delete(event.requestId)) this.dependencies.push('permissions:pending', this.listPendingPermissions())
        break
      case 'runner_state':
        if (event.state === 'running' || event.state === 'starting' || event.state === 'interrupting') this.busyRunners.add(event.conversationId)
        else this.busyRunners.delete(event.conversationId)
        if (event.state === 'closed' || event.state === 'error') {
          this.dropPermissionsFor(event.conversationId)
          this.launchedBypass.delete(event.conversationId)
        }
        if (event.state !== 'running' && event.state !== 'starting' && event.state !== 'interrupting' && this.restartAfterTurn.delete(event.conversationId)) void this.closeRunner(event.conversationId).catch(() => undefined)
        break
      default:
        break
    }
    this.dependencies.push('engine:event', event)
  }
}
