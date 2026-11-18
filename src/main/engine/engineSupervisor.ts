/**
 * Owns the engine host process: controlled start, clean stop, crash detection,
 * bounded restarts, orphan cleanup and RPC with timeouts.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { APP_CONFIG } from '../../shared/appConfig'
import type { EngineHostState, EngineStatus, RunnerState } from '../../shared/domain'
import { hostMessageSchema, type EngineEvent, type HostCommand, type HostMessage, type HostRpcMethod, type HostRpcRequest, type HostRpcResponse, type HostRpcResultMap } from '../../shared/engineProtocol'
import type { ScopedLogger } from '../services/logger'

export interface HostProcessHandle {
  readonly pid: number | undefined
  postMessage(message: HostCommand): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  kill(): boolean
}

export type HostProcessFactory = () => HostProcessHandle

interface PendingRpc {
  resolve: (response: HostRpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface SupervisorEvents {
  event: [EngineEvent]
  status: [EngineStatus]
}

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

export class EngineSupervisor extends EventEmitter<SupervisorEvents> {
  private handle: HostProcessHandle | null = null
  private hostState: EngineHostState = 'stopped'
  private readyPromise: Promise<void> | null = null
  private readonly pendingRpcs = new Map<string, PendingRpc>()
  private readonly runnerStates = new Map<string, RunnerState>()
  private readonly childPids = new Set<number>()
  private restartTimestamps: number[] = []
  private restartCount = 0
  private lastError: string | undefined
  private stopping = false

  constructor(
    private readonly factory: HostProcessFactory,
    private readonly log: ScopedLogger,
    private readonly killTree: (pid: number) => void = killProcessTree
  ) {
    super()
  }

  status(): EngineStatus {
    let busy = 0
    for (const state of this.runnerStates.values()) if (state === 'running' || state === 'starting' || state === 'interrupting') busy += 1
    return { hostState: this.hostState, restartCount: this.restartCount, lastError: this.lastError, activeRunners: this.runnerStates.size, busyRunners: busy }
  }

  isRunnerActive(conversationId: string): boolean {
    const state = this.runnerStates.get(conversationId)
    return state !== undefined && state !== 'closed' && state !== 'error'
  }

  activeConversationIds(): string[] {
    return [...this.runnerStates.entries()].filter(([, state]) => state !== 'closed' && state !== 'error').map(([conversationId]) => conversationId)
  }

  runnerState(conversationId: string): RunnerState | undefined {
    return this.runnerStates.get(conversationId)
  }

  private setHostState(state: EngineHostState): void {
    this.hostState = state
    this.emit('status', this.status())
  }

  /** Starts the host if needed and resolves once it reported `ready`. */
  ensureStarted(): Promise<void> {
    if (this.handle && this.readyPromise) return this.readyPromise
    this.stopping = false
    this.setHostState(this.restartCount > 0 ? 'restarting' : 'starting')
    let handle: HostProcessHandle
    try {
      handle = this.factory()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setHostState('failed')
      return Promise.reject(new Error(`Impossible de démarrer le moteur : ${this.lastError}`))
    }
    this.handle = handle
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(() => reject(new Error('Le moteur n’a pas répondu au démarrage.')), 20_000)
      handle.onMessage((raw) => {
        const parsed = hostMessageSchema.safeParse(raw)
        if (!parsed.success) {
          this.log.warn('Message du moteur ignoré (format invalide)')
          return
        }
        const message = raw as HostMessage
        if (message.type === 'ready') {
          clearTimeout(readyTimer)
          this.setHostState('running')
          resolve()
          return
        }
        this.handleHostMessage(message)
      })
      handle.onExit((code) => {
        clearTimeout(readyTimer)
        reject(new Error(`Le moteur s’est arrêté (code ${code}).`))
        this.handleExit(handle, code)
      })
    })
    this.readyPromise.catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log.error('Démarrage du moteur échoué', error)
    })
    return this.readyPromise
  }

  private handleHostMessage(message: HostMessage): void {
    if (message.type === 'rpc_result') {
      const pending = this.pendingRpcs.get(message.rpcId)
      if (!pending) return
      this.pendingRpcs.delete(message.rpcId)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.response)
      else pending.reject(new Error(message.error))
      return
    }
    if (message.type !== 'event') return
    const event = message.event
    if (event.type === 'runner_state') {
      if (event.state === 'closed' || event.state === 'error') this.runnerStates.delete(event.conversationId)
      else this.runnerStates.set(event.conversationId, event.state)
      this.emit('status', this.status())
    } else if (event.type === 'child_process') {
      if (event.alive) this.childPids.add(event.pid)
      else this.childPids.delete(event.pid)
      return
    } else if (event.type === 'log') {
      this.log[event.level](event.message, event.details)
      return
    }
    this.emit('event', event)
  }

  private handleExit(handle: HostProcessHandle, code: number): void {
    if (this.handle !== handle) return
    this.handle = null
    this.readyPromise = null
    for (const [rpcId, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Le moteur s’est arrêté pendant la requête.'))
      this.pendingRpcs.delete(rpcId)
    }
    this.cleanOrphans()
    const interrupted = [...this.runnerStates.keys()]
    this.runnerStates.clear()
    if (this.stopping) {
      this.setHostState('stopped')
      return
    }
    this.lastError = `Le moteur s’est arrêté de façon inattendue (code ${code}).`
    this.log.error(this.lastError)
    for (const conversationId of interrupted) {
      this.emit('event', { type: 'runner_state', conversationId, state: 'error', message: 'Le moteur Claude Code a redémarré. Le contexte est conservé par Claude Code : votre prochain message reprendra la session.' })
    }
    const now = Date.now()
    this.restartTimestamps = this.restartTimestamps.filter((timestamp) => now - timestamp < APP_CONFIG.engineRestartWindowMs)
    if (this.restartTimestamps.length >= APP_CONFIG.engineMaxRestartsPerWindow) {
      this.setHostState('failed')
      this.log.error('Trop de redémarrages du moteur, arrêt des tentatives automatiques.')
      return
    }
    this.restartTimestamps.push(now)
    this.restartCount += 1
    this.setHostState('crashed')
    const delay = Math.min(10_000, 500 * 2 ** (this.restartTimestamps.length - 1))
    setTimeout(() => {
      if (!this.handle && !this.stopping) this.ensureStarted().catch(() => undefined)
    }, delay)
  }

  /** Kills Claude Code CLI processes left behind by a dead host. */
  cleanOrphans(): void {
    for (const pid of this.childPids) {
      this.log.warn(`Arrêt d’un processus Claude Code orphelin (PID ${pid})`)
      this.killTree(pid)
    }
    this.childPids.clear()
  }

  async send(command: HostCommand): Promise<void> {
    await this.ensureStarted()
    if (!this.handle) throw new Error('Moteur indisponible.')
    if (command.type === 'start_runner') this.runnerStates.set(command.conversationId, 'starting')
    this.handle.postMessage(command)
  }

  async rpc<Method extends HostRpcMethod>(request: Extract<HostRpcRequest, { method: Method }>, timeoutMs: number = APP_CONFIG.engineRpcTimeoutMs): Promise<HostRpcResultMap[Method]> {
    await this.ensureStarted()
    const handle = this.handle
    if (!handle) throw new Error('Moteur indisponible.')
    const rpcId = randomUUID()
    const response = await new Promise<HostRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(rpcId)
        reject(new Error(`Le moteur n’a pas répondu (${request.method}).`))
      }, timeoutMs)
      this.pendingRpcs.set(rpcId, { resolve, reject, timer })
      handle.postMessage({ type: 'rpc', rpcId, request })
    })
    return response.result as HostRpcResultMap[Method]
  }

  /** Manual restart requested by the user. */
  async restart(): Promise<void> {
    await this.stop()
    this.restartTimestamps = []
    this.restartCount += 1
    await this.ensureStarted()
  }

  async stop(): Promise<void> {
    const handle = this.handle
    if (!handle) return
    this.stopping = true
    try {
      handle.postMessage({ type: 'shutdown' })
    } catch {
      // channel already closed
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        handle.kill()
        resolve()
      }, 3000)
      handle.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.cleanOrphans()
    this.handle = null
    this.readyPromise = null
    this.setHostState('stopped')
  }
}
