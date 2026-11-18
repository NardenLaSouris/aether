import { describe, expect, it } from 'vitest'
import { EngineSupervisor, type HostProcessHandle } from '../../src/main/engine/engineSupervisor'
import type { ScopedLogger } from '../../src/main/services/logger'
import type { EngineEvent, HostCommand, HostMessage } from '../../src/shared/engineProtocol'

const silentLog: ScopedLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

class FakeHost implements HostProcessHandle {
  pid = Math.floor(Math.random() * 10_000)
  received: HostCommand[] = []
  private messageListeners: ((message: unknown) => void)[] = []
  private exitListeners: ((code: number) => void)[] = []
  autoAnswer = true
  postMessage(message: HostCommand): void {
    this.received.push(message)
    if (message.type === 'rpc' && this.autoAnswer) {
      queueMicrotask(() => this.deliver({ type: 'rpc_result', rpcId: message.rpcId, ok: true, response: { method: 'list_sessions', result: [] } }))
    }
    if (message.type === 'shutdown') queueMicrotask(() => this.exit(0))
  }
  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener)
  }
  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener)
  }
  kill(): boolean {
    this.exit(1)
    return true
  }
  deliver(message: HostMessage | Record<string, unknown>): void {
    for (const listener of this.messageListeners) listener(message)
  }
  exit(code: number): void {
    for (const listener of this.exitListeners.splice(0)) listener(code)
  }
}

function setup() {
  const hosts: FakeHost[] = []
  const killed: number[] = []
  const supervisor = new EngineSupervisor(
    () => {
      const host = new FakeHost()
      hosts.push(host)
      queueMicrotask(() => host.deliver({ type: 'ready' }))
      return host
    },
    silentLog,
    (pid) => killed.push(pid)
  )
  const events: EngineEvent[] = []
  supervisor.on('event', (event) => events.push(event))
  return { supervisor, hosts, killed, events }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('EngineSupervisor', () => {
  it('starts the host on demand and answers RPCs', async () => {
    const { supervisor, hosts } = setup()
    await expect(supervisor.rpc({ method: 'list_sessions', limit: 10 })).resolves.toEqual([])
    expect(hosts).toHaveLength(1)
    expect(supervisor.status().hostState).toBe('running')
  })

  it('tracks runner states from events', async () => {
    const { supervisor, hosts } = setup()
    await supervisor.send({ type: 'start_runner', conversationId: 'c1', executablePath: 'x', workingDirectory: 'y', model: null, permissionMode: 'default', resumeSessionId: null })
    expect(supervisor.isRunnerActive('c1')).toBe(true)
    hosts[0]?.deliver({ type: 'event', event: { type: 'runner_state', conversationId: 'c1', state: 'running' } })
    expect(supervisor.status().busyRunners).toBe(1)
    hosts[0]?.deliver({ type: 'event', event: { type: 'runner_state', conversationId: 'c1', state: 'closed' } })
    expect(supervisor.isRunnerActive('c1')).toBe(false)
  })

  it('ignores malformed host messages', async () => {
    const { supervisor, hosts, events } = setup()
    await supervisor.ensureStarted()
    hosts[0]?.deliver({ nonsense: true })
    hosts[0]?.deliver({ type: 'event' })
    expect(events).toHaveLength(0)
  })

  it('times out RPCs that never answer', async () => {
    const { supervisor, hosts } = setup()
    await supervisor.ensureStarted()
    if (hosts[0]) hosts[0].autoAnswer = false
    await expect(supervisor.rpc({ method: 'list_sessions', limit: 1 }, 30)).rejects.toThrow(/pas répondu/)
  })

  it('survives a host crash: rejects pending work, kills orphans, marks runners and restarts', async () => {
    const { supervisor, hosts, killed, events } = setup()
    await supervisor.send({ type: 'start_runner', conversationId: 'c1', executablePath: 'x', workingDirectory: 'y', model: null, permissionMode: 'default', resumeSessionId: null })
    hosts[0]?.deliver({ type: 'event', event: { type: 'child_process', conversationId: 'c1', pid: 4242, alive: true } })
    if (hosts[0]) hosts[0].autoAnswer = false
    const pending = supervisor.rpc({ method: 'list_sessions', limit: 1 })
    await wait(0)
    hosts[0]?.exit(3)
    await expect(pending).rejects.toThrow(/arrêté/)
    expect(killed).toEqual([4242])
    expect(events.find((event) => event.type === 'runner_state')).toMatchObject({ conversationId: 'c1', state: 'error' })
    expect(supervisor.status().hostState).toBe('crashed')
    await wait(700)
    expect(hosts).toHaveLength(2)
    expect(supervisor.status().hostState).toBe('running')
    expect(supervisor.status().restartCount).toBe(1)
  })

  it('stops restarting after too many crashes', async () => {
    const { supervisor, hosts } = setup()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await supervisor.ensureStarted()
      hosts.at(-1)?.exit(1)
      await wait(attempt < 5 ? 500 * 2 ** attempt + 50 : 50)
      if (supervisor.status().hostState === 'failed') break
    }
    expect(supervisor.status().hostState).toBe('failed')
  }, 30_000)

  it('stops cleanly', async () => {
    const { supervisor, hosts } = setup()
    await supervisor.ensureStarted()
    await supervisor.stop()
    expect(hosts[0]?.received.at(-1)).toEqual({ type: 'shutdown' })
    expect(supervisor.status().hostState).toBe('stopped')
  })
})
