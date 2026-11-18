/**
 * Dispatches commands from the main process to conversation runners and answers RPC calls.
 * Transport-agnostic so it can be unit tested without Electron.
 */
import { spawn } from 'node:child_process'
import type { Options, Query, SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import type { RunnerExtensions } from '../shared/domain'
import { extensionSdkOptions, type EngineEvent, type HostCommand, type HostMessage, type HostRpcRequest, type HostRpcResponse, type ProbeResult, type UsageApiResult } from '../shared/engineProtocol'
import { timelineFromHistory, type HistoryMessageLike } from '../shared/timeline'
import { ConversationRunner, type QueryFactory } from './conversationRunner'
import { MessageQueue } from './messageQueue'

export interface SdkSurface {
  query: QueryFactory
  listSessions: (options: { limit?: number }) => Promise<{ sessionId: string; summary: string; lastModified: number; createdAt?: number; cwd?: string; gitBranch?: string; firstPrompt?: string; customTitle?: string; fileSize?: number }[]>
  getSessionMessages: (sessionId: string, options: { dir?: string; limit?: number }) => Promise<HistoryMessageLike[]>
}

const PROBE_TIMEOUT_MS = 45_000

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} : délai dépassé (${Math.round(timeoutMs / 1000)} s)`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export class HostController {
  private readonly runners = new Map<string, ConversationRunner>()
  private readonly permissionOwner = new Map<string, string>()

  constructor(
    private readonly sdk: SdkSurface,
    private readonly post: (message: HostMessage) => void
  ) {}

  private emit = (event: EngineEvent): void => {
    if (event.type === 'permission_request') this.permissionOwner.set(event.requestId, event.conversationId)
    if (event.type === 'permission_cancelled') this.permissionOwner.delete(event.requestId)
    if (event.type === 'runner_state' && (event.state === 'closed' || event.state === 'error')) {
      const runner = this.runners.get(event.conversationId)
      if (runner && (runner.state === 'closed' || runner.state === 'error')) this.runners.delete(event.conversationId)
    }
    this.post({ type: 'event', event })
  }

  /** Spawns the Claude Code CLI like the SDK would, but records PIDs so the main process can clean orphans. */
  private createSpawner(conversationId: string): (options: SpawnOptions) => SpawnedProcess {
    return (options: SpawnOptions): SpawnedProcess => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal: options.signal
      })
      if (child.pid) this.emit({ type: 'child_process', conversationId, pid: child.pid, alive: true })
      child.stderr?.on('data', (chunk: Buffer) => this.emit({ type: 'log', level: 'debug', message: `[claude stderr] ${conversationId}`, details: chunk.toString('utf8').slice(0, 4000) }))
      child.once('exit', () => {
        if (child.pid) this.emit({ type: 'child_process', conversationId, pid: child.pid, alive: false })
      })
      return child as unknown as SpawnedProcess
    }
  }

  get activeRunnerCount(): number {
    return this.runners.size
  }

  async handle(command: HostCommand): Promise<void> {
    switch (command.type) {
      case 'start_runner': {
        const existing = this.runners.get(command.conversationId)
        if (existing && existing.state !== 'closed' && existing.state !== 'error') return
        const runner = new ConversationRunner(command, { queryFactory: this.sdk.query, emit: this.emit, spawnClaudeCodeProcess: this.createSpawner(command.conversationId) })
        this.runners.set(command.conversationId, runner)
        runner.start()
        return
      }
      case 'send_message': {
        const runner = this.runners.get(command.conversationId)
        if (!runner) {
          this.emit({ type: 'runner_state', conversationId: command.conversationId, state: 'error', message: 'Aucune session active pour cette conversation. Réessayez.' })
          return
        }
        runner.send(command.text, command.clientMessageId, command.images ?? [])
        return
      }
      case 'set_effort':
        await this.runners.get(command.conversationId)?.setEffort(command.effort)
        return
      case 'interrupt':
        await this.runners.get(command.conversationId)?.interrupt()
        return
      case 'set_model':
        await this.runners.get(command.conversationId)?.setModel(command.model)
        return
      case 'set_permission_mode':
        await this.runners.get(command.conversationId)?.setPermissionMode(command.permissionMode)
        return
      case 'close_runner': {
        const runner = this.runners.get(command.conversationId)
        runner?.close()
        this.runners.delete(command.conversationId)
        return
      }
      case 'permission_decision': {
        const conversationId = this.permissionOwner.get(command.requestId)
        const runner = conversationId ? this.runners.get(conversationId) : undefined
        if (!runner) return
        this.permissionOwner.delete(command.requestId)
        const input = runner.inputForRequest(command.requestId)
        // The answers to Claude's questions travel in the tool's input, as Claude Code's own dialog does.
        runner.resolvePermission(command.requestId, command.allow, command.message, command.answers && input ? { ...input, answers: { ...command.answers } } : input)
        return
      }
      case 'rpc':
        await this.handleRpc(command.rpcId, command.request)
        return
      case 'shutdown':
        for (const runner of this.runners.values()) runner.close()
        this.runners.clear()
        return
    }
  }

  private async handleRpc(rpcId: string, request: HostRpcRequest): Promise<void> {
    try {
      const response = await this.executeRpc(request)
      this.post({ type: 'rpc_result', rpcId, ok: true, response })
    } catch (error) {
      this.post({ type: 'rpc_result', rpcId, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Opens a short-lived query with no prompt, just to read the initialisation data, then closes it. */
  private async withProbeQuery<Value>(executablePath: string, workingDirectory: string, action: (probe: Query) => Promise<Value>, extensions?: RunnerExtensions): Promise<Value> {
    const idleInput = new MessageQueue<SDKUserMessage>()
    const options: Options = {
      cwd: workingDirectory,
      pathToClaudeCodeExecutable: executablePath,
      permissionMode: 'default',
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      spawnClaudeCodeProcess: this.createSpawner('probe'),
      ...extensionSdkOptions(extensions)
    }
    const probe = this.sdk.query({ prompt: idleInput, options })
    // Drain messages so the transport does not stall; nothing is displayed.
    const drain = (async () => {
      try {
        for await (const _message of probe) {
          // ignore
        }
      } catch {
        // closing the probe ends the iterator with an error on some versions
      }
    })()
    try {
      return await withTimeout(action(probe), PROBE_TIMEOUT_MS, 'Interrogation du moteur Claude Code')
    } finally {
      idleInput.end()
      try {
        probe.close()
      } catch {
        // already closed
      }
      await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
  }

  private async executeRpc(request: HostRpcRequest): Promise<HostRpcResponse> {
    switch (request.method) {
      case 'probe': {
        const result = await this.withProbeQuery(request.executablePath, request.workingDirectory, async (probe): Promise<ProbeResult> => {
          const initialisation = await probe.initializationResult()
          return {
            models: initialisation.models.map((model) => ({
              value: model.value,
              displayName: model.displayName,
              description: model.description,
              resolvedModel: model.resolvedModel,
              supportsEffort: model.supportsEffort,
              supportsFastMode: model.supportsFastMode
            })),
            account: { ...initialisation.account },
            claudeCodeVersion: initialisation.claude_code_version ?? null,
            commands: initialisation.commands.map((command) => ({ name: command.name, description: command.description, builtin: command.builtin === true }))
          }
        }, request.extensions)
        return { method: 'probe', result }
      }
      case 'usage': {
        const readUsage = async (target: Query): Promise<UsageApiResult> => {
          const usage = await target.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
          const limits = usage.rate_limits
          return {
            subscriptionType: usage.subscription_type,
            rateLimitsAvailable: usage.rate_limits_available,
            windows: limits
              ? { five_hour: limits.five_hour ?? null, seven_day: limits.seven_day ?? null, seven_day_opus: limits.seven_day_opus ?? null, seven_day_sonnet: limits.seven_day_sonnet ?? null }
              : {},
            sessionCostUsd: usage.session?.total_cost_usd ?? null
          }
        }
        const liveQuery = request.conversationId ? this.runners.get(request.conversationId)?.query : null
        const result = liveQuery ? await withTimeout(readUsage(liveQuery), PROBE_TIMEOUT_MS, 'Lecture de l’usage') : await this.withProbeQuery(request.executablePath, request.workingDirectory, readUsage)
        return { method: 'usage', result }
      }
      case 'list_sessions': {
        const sessions = await this.sdk.listSessions({ limit: request.limit })
        return {
          method: 'list_sessions',
          result: sessions.map((session) => ({
            sessionId: session.sessionId,
            summary: session.summary,
            lastModified: session.lastModified,
            createdAt: session.createdAt,
            cwd: session.cwd,
            gitBranch: session.gitBranch,
            firstPrompt: session.firstPrompt,
            customTitle: session.customTitle,
            fileSize: session.fileSize
          }))
        }
      }
      case 'session_history': {
        const messages = await this.sdk.getSessionMessages(request.sessionId, { dir: request.directory ?? undefined, limit: request.limit })
        return { method: 'session_history', result: timelineFromHistory(messages) }
      }
      case 'rewind_files': {
        const runner = this.runners.get(request.conversationId)
        if (!runner) throw new Error('Aucune session active pour cette conversation.')
        return { method: 'rewind_files', result: await runner.rewindFiles(request.userMessageId, request.dryRun) }
      }
    }
  }

  shutdown(): void {
    for (const runner of this.runners.values()) runner.close()
    this.runners.clear()
  }
}
