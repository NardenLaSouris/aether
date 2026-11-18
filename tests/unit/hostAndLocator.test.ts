import { describe, expect, it } from 'vitest'
import { HostController, type SdkSurface } from '../../src/engine-host/hostController'
import { detectClaudeInstallation, parseAuthStatus, parseVersion, pickFromWhereOutput } from '../../src/main/engine/claudeLocator'
import type { HostMessage } from '../../src/shared/engineProtocol'
import { createFakeQueryFactory, flushPromises } from './helpers/fakeQuery'

function controller() {
  const { factory, handles } = createFakeQueryFactory()
  const posted: HostMessage[] = []
  const sdk: SdkSurface = {
    query: factory,
    listSessions: async () => [{ sessionId: 's1', summary: 'Résumé', lastModified: 10, cwd: 'C:\\p' }],
    getSessionMessages: async () => [{ type: 'user', uuid: 'u', message: { role: 'user', content: 'Bonjour' } }]
  }
  return { host: new HostController(sdk, (message) => posted.push(message)), posted, handles }
}

describe('HostController', () => {
  it('answers list_sessions and session_history through the SDK functions', async () => {
    const { host, posted } = controller()
    await host.handle({ type: 'rpc', rpcId: 'r1', request: { method: 'list_sessions', limit: 5 } })
    await host.handle({ type: 'rpc', rpcId: 'r2', request: { method: 'session_history', sessionId: 's1', directory: null, limit: 10 } })
    expect(posted[0]).toMatchObject({ type: 'rpc_result', rpcId: 'r1', ok: true, response: { method: 'list_sessions', result: [{ sessionId: 's1', summary: 'Résumé' }] } })
    expect(posted[1]).toMatchObject({ rpcId: 'r2', ok: true, response: { result: [{ kind: 'user', text: 'Bonjour' }] } })
  })

  it('probes models and account with a short-lived session-less query', async () => {
    const { host, posted, handles } = controller()
    await host.handle({ type: 'rpc', rpcId: 'p', request: { method: 'probe', executablePath: 'C:\\claude.exe', workingDirectory: 'C:\\' } })
    expect(handles[0]?.options.persistSession).toBe(false)
    expect(handles[0]?.calls.close).toBe(1)
    expect(posted[0]).toMatchObject({ ok: true, response: { method: 'probe', result: { models: [{ value: 'model-a', displayName: 'Model A' }], account: { email: 'test@example.com' }, claudeCodeVersion: '9.9.9' } } })
  })

  it('reads the official usage data', async () => {
    const { host, posted } = controller()
    await host.handle({ type: 'rpc', rpcId: 'u', request: { method: 'usage', executablePath: 'x', workingDirectory: 'y', conversationId: null } })
    expect(posted[0]).toMatchObject({ ok: true, response: { method: 'usage', result: { rateLimitsAvailable: true, windows: { five_hour: { utilization: 42 } } } } })
  })

  it('routes permission decisions to the owning runner', async () => {
    const { host, posted, handles } = controller()
    await host.handle({ type: 'start_runner', conversationId: 'c1', executablePath: 'x', workingDirectory: 'y', model: null, permissionMode: 'default', resumeSessionId: null })
    const canUseTool = handles[0]?.options.canUseTool
    const decision = canUseTool?.('Write', { file_path: 'a' }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'req' } as never)
    await flushPromises()
    expect(posted.some((message) => message.type === 'event' && message.event.type === 'permission_request')).toBe(true)
    await host.handle({ type: 'permission_decision', requestId: 'req', allow: true })
    await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedInput: { file_path: 'a' } })
  })

  it('reports an error when sending to a conversation without a runner', async () => {
    const { host, posted } = controller()
    await host.handle({ type: 'send_message', conversationId: 'nope', text: 'x', clientMessageId: 'y' })
    expect(posted[0]).toMatchObject({ type: 'event', event: { type: 'runner_state', state: 'error' } })
  })

  it('reports RPC failures', async () => {
    const { factory } = createFakeQueryFactory()
    const posted: HostMessage[] = []
    const host = new HostController({ query: factory, listSessions: async () => Promise.reject(new Error('disk error')), getSessionMessages: async () => [] }, (message) => posted.push(message))
    await host.handle({ type: 'rpc', rpcId: 'x', request: { method: 'list_sessions', limit: 1 } })
    expect(posted[0]).toEqual({ type: 'rpc_result', rpcId: 'x', ok: false, error: 'disk error' })
  })
})

describe('claudeLocator', () => {
  it('parses versions and where.exe output', () => {
    expect(parseVersion('2.1.319 (Claude Code)')).toBe('2.1.319')
    expect(parseVersion('nothing')).toBeNull()
    expect(pickFromWhereOutput('C:\\a\\claude\r\nC:\\Users\\me\\.local\\bin\\claude.exe\r\n')).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(pickFromWhereOutput('')).toBeNull()
  })

  it('parses claude auth status JSON', () => {
    const status = parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"pro","loginExpiresAt":"2026-12-01T00:00:00Z"}')
    expect(status).toEqual({ checked: true, loggedIn: true, authMethod: 'claude.ai', apiProvider: undefined, email: 'a@b.c', subscriptionType: 'pro', loginExpiresAt: '2026-12-01T00:00:00Z' })
    expect(parseAuthStatus('{"loggedIn":false}').loggedIn).toBe(false)
    expect(parseAuthStatus('Not logged in').error).toBe('Not logged in')
  })

  it('reports a missing installation honestly', async () => {
    const result = await detectClaudeInstallation('C:\\nope\\claude.exe', async () => ({ stdout: '', stderr: 'not found', exitCode: 1 }))
    // Known locations may exist on the test machine; when nothing runs, found must be false.
    expect(result.found).toBe(false)
  })
})
