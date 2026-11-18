import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/database/appDatabase'
import { createRepositories, type Repositories } from '../../src/main/database/repositories'
import { QuotaManager } from '../../src/main/quota/quotaManager'
import { ChatService, deriveTitle, DEFAULT_CONVERSATION_TITLE, type EngineLike } from '../../src/main/services/chatService'
import { SessionService, sessionTitle } from '../../src/main/services/sessionService'
import type { ScopedLogger } from '../../src/main/services/logger'
import { DEFAULT_PREFERENCES, type ClaudeInstallation } from '../../src/shared/domain'
import type { HostCommand, HostRpcRequest } from '../../src/shared/engineProtocol'

const silentLog: ScopedLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class FakeEngine implements EngineLike {
  sent: HostCommand[] = []
  rpcs: HostRpcRequest[] = []
  active = new Set<string>()
  rpcResults: Record<string, unknown> = {}
  async send(command: HostCommand): Promise<void> {
    this.sent.push(command)
    if (command.type === 'start_runner') this.active.add(command.conversationId)
    if (command.type === 'close_runner') this.active.delete(command.conversationId)
  }
  async rpc(request: HostRpcRequest): Promise<never> {
    this.rpcs.push(request)
    if (!(request.method in this.rpcResults)) throw new Error('no result')
    return this.rpcResults[request.method] as never
  }
  isRunnerActive(conversationId: string): boolean {
    return this.active.has(conversationId)
  }
}

async function setup(installation: ClaudeInstallation = { found: true, executablePath: 'C:\\claude.exe', version: '2.1.0', detectionSource: 'path' }) {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'aether-chat-'))
  directories.push(workingDirectory)
  const database = await AppDatabase.open({ filePath: null })
  const repositories: Repositories = createRepositories(database)
  const engine = new FakeEngine()
  const pushed: { channel: string; payload: unknown }[] = []
  const quota = new QuotaManager({
    now: () => Date.now(),
    setTimer: () => null,
    clearTimer: () => undefined,
    notify: () => undefined,
    recordEvent: (event) => repositories.quotaEvents.record(event),
    readUsage: async () => ({ subscriptionType: null, rateLimitsAvailable: false, windows: {}, sessionCostUsd: null }),
    onStateChange: () => undefined,
    isSubscriptionAccount: () => true
  })
  const chat = new ChatService({ repositories, engine, quota, getInstallation: () => installation, getPreferences: () => DEFAULT_PREFERENCES, push: (channel, payload) => pushed.push({ channel, payload }), notify: () => undefined, log: silentLog })
  const sessions = new SessionService({ repositories, engine, getPreferences: () => DEFAULT_PREFERENCES, log: silentLog })
  const conversation = repositories.conversations.create({ title: DEFAULT_CONVERSATION_TITLE, projectId: null, workingDirectory })
  return { chat, sessions, engine, repositories, conversation, quota, pushed, workingDirectory }
}

describe('ChatService — sending', () => {
  it('starts a runner on first send, then reuses it, and titles the conversation', async () => {
    const { chat, engine, conversation, repositories } = await setup()
    await expect(chat.send(conversation.id, 'Explique le module de paiement\nen détail', 'm1')).resolves.toEqual({ accepted: true })
    expect(engine.sent.map((command) => command.type)).toEqual(['start_runner', 'send_message'])
    expect(engine.sent[0]).toMatchObject({ resumeSessionId: null, permissionMode: 'default', executablePath: 'C:\\claude.exe' })
    expect(repositories.conversations.findById(conversation.id)?.title).toBe('Explique le module de paiement')
    await chat.send(conversation.id, 'Et ensuite ?', 'm2')
    expect(engine.sent.map((command) => command.type)).toEqual(['start_runner', 'send_message', 'send_message'])
  })

  it('resumes with the stored Claude session id', async () => {
    const { chat, engine, conversation, repositories } = await setup()
    repositories.conversations.setSessionId(conversation.id, 'session-42')
    await chat.send(conversation.id, 'Reprise', 'm1')
    expect(engine.sent[0]).toMatchObject({ type: 'start_runner', resumeSessionId: 'session-42' })
  })

  it('refuses to send while a quota block is active and does not contact the engine', async () => {
    const { chat, engine, conversation, quota } = await setup()
    quota.handleRateLimit({ status: 'rejected', resetsAt: Math.round(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' })
    const result = await chat.send(conversation.id, 'x', 'm1')
    expect(result.accepted).toBe(false)
    expect(result.reason).toMatch(/Reprise possible/)
    expect(engine.sent).toHaveLength(0)
  })

  it('refuses to send when Claude Code is not installed', async () => {
    const { chat, conversation } = await setup({ found: false, executablePath: null, version: null, detectionSource: 'none' })
    expect((await chat.send(conversation.id, 'x', 'm1')).accepted).toBe(false)
  })

  it('derives readable titles', () => {
    expect(deriveTitle('   \n  Corrige le bug  ')).toBe('Corrige le bug')
    expect(deriveTitle('a'.repeat(100))).toHaveLength(58)
    expect(deriveTitle('')).toBe(DEFAULT_CONVERSATION_TITLE)
  })
})

describe('ChatService — engine events', () => {
  it('stores the session id from system/init and records turn usage', async () => {
    const { chat, conversation, repositories } = await setup()
    await chat.send(conversation.id, 'x', 'm1')
    chat.handleEngineEvent({ type: 'session_init', conversationId: conversation.id, sessionId: 'new-session', model: 'model-a', workingDirectory: conversation.workingDirectory, tools: [], permissionMode: 'default', claudeCodeVersion: '2' })
    expect(repositories.conversations.findById(conversation.id)?.claudeSessionId).toBe('new-session')
    const result = { subtype: 'success', isError: false, durationMs: 10, totalCostUsd: 0.02, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, errors: [], resultText: 'ok', apiErrorStatus: null, model: 'model-a' }
    chat.handleEngineEvent({ type: 'turn_result', conversationId: conversation.id, sessionId: 'new-session', result })
    chat.handleEngineEvent({ type: 'turn_result', conversationId: conversation.id, sessionId: 'new-session', result: { ...result, totalCostUsd: 0.05 } })
    const usage = repositories.usage.recent(10)
    expect(usage).toHaveLength(2)
    // Per-turn cost is derived from the cumulative total of a fresh session.
    expect(usage.map((event) => event.estimatedCostUsd?.toFixed(2)).sort()).toEqual(['0.02', '0.03'])
  })

  it('does not attribute a resumed session’s earlier cost to the first turn', async () => {
    const { chat, conversation, repositories } = await setup()
    repositories.conversations.setSessionId(conversation.id, 'old')
    await chat.send(conversation.id, 'x', 'm1')
    chat.handleEngineEvent({ type: 'turn_result', conversationId: conversation.id, sessionId: 'old', result: { subtype: 'success', isError: false, durationMs: 1, totalCostUsd: 3.5, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, errors: [], resultText: '', apiErrorStatus: null, model: null } })
    expect(repositories.usage.recent(1)[0]?.estimatedCostUsd).toBeNull()
  })

  it('tracks pending permissions and forwards decisions', async () => {
    const { chat, engine, conversation } = await setup()
    chat.handleEngineEvent({ type: 'permission_request', conversationId: conversation.id, requestId: 'r1', toolName: 'Write', toolUseId: 't1', input: { file_path: 'a.txt' } })
    expect(chat.listPendingPermissions()).toHaveLength(1)
    await chat.decidePermission('r1', false, 'non')
    expect(chat.listPendingPermissions()).toHaveLength(0)
    expect(engine.sent.at(-1)).toEqual({ type: 'permission_decision', requestId: 'r1', allow: false, message: 'non' })
    // Unknown request ids are ignored.
    await chat.decidePermission('unknown', true)
    expect(engine.sent.filter((command) => command.type === 'permission_decision')).toHaveLength(1)
  })

  it('forwards the answers to Claude’s questions, and only for AskUserQuestion', async () => {
    const { chat, engine, conversation } = await setup()
    chat.handleEngineEvent({ type: 'permission_request', conversationId: conversation.id, requestId: 'q1', toolName: 'AskUserQuestion', toolUseId: 't1', input: { questions: [] } })
    await chat.decidePermission('q1', true, undefined, { 'Quelle base ?': 'SQLite' })
    expect(engine.sent.at(-1)).toEqual({ type: 'permission_decision', requestId: 'q1', allow: true, answers: { 'Quelle base ?': 'SQLite' } })
    chat.handleEngineEvent({ type: 'permission_request', conversationId: conversation.id, requestId: 'w1', toolName: 'Write', toolUseId: 't2', input: { file_path: 'a.txt' } })
    await chat.decidePermission('w1', true, undefined, { injected: 'x' })
    expect(engine.sent.at(-1)).toEqual({ type: 'permission_decision', requestId: 'w1', allow: true })
  })

  it('sends pasted images and starts the session with the conversation’s effort', async () => {
    const { chat, engine, conversation } = await setup()
    const withEffort = new ChatService({ ...(chat as unknown as { dependencies: ConstructorParameters<typeof ChatService>[0] }).dependencies, getPreferences: () => ({ ...DEFAULT_PREFERENCES, defaultEffort: 'low', conversationEfforts: { [conversation.id]: 'max' } }) })
    await withEffort.send(conversation.id, 'Regarde', 'm1', [{ mediaType: 'image/png', data: 'AAAA' }])
    expect(engine.sent[0]).toMatchObject({ type: 'start_runner', effort: 'max' })
    expect(engine.sent[1]).toMatchObject({ type: 'send_message', text: 'Regarde', images: [{ mediaType: 'image/png', data: 'AAAA' }] })
  })

  it('a usage-limit error from the engine blocks further sends', async () => {
    const { chat, conversation } = await setup()
    chat.handleEngineEvent({ type: 'assistant_message', conversationId: conversation.id, messageId: 'm', blocks: [{ kind: 'text', text: "You've hit your session limit · resets 4pm" }], model: null, error: 'rate_limit', parentToolUseId: null })
    expect((await chat.send(conversation.id, 'x', 'm1')).accepted).toBe(false)
  })

  it('interrupt and delete close the runner without touching Claude transcripts', async () => {
    const { chat, engine, conversation, repositories } = await setup()
    await chat.send(conversation.id, 'x', 'm1')
    await chat.interrupt(conversation.id)
    expect(engine.sent.at(-1)).toEqual({ type: 'interrupt', conversationId: conversation.id })
    await chat.deleteConversation(conversation.id)
    expect(engine.sent.at(-1)).toEqual({ type: 'close_runner', conversationId: conversation.id })
    expect(repositories.conversations.findById(conversation.id)).toBeNull()
  })

  it('loads history through the official transcript reader', async () => {
    const { chat, engine, conversation, repositories } = await setup()
    repositories.conversations.setSessionId(conversation.id, 'session-h')
    engine.rpcResults.session_history = [{ kind: 'user', id: 'u', text: 'hello', timestamp: 1 }]
    const history = await chat.history(conversation.id)
    expect(history.source).toBe('claude-transcript')
    expect(history.items).toHaveLength(1)
    expect(engine.rpcs[0]).toMatchObject({ method: 'session_history', sessionId: 'session-h', directory: conversation.workingDirectory })
  })
})

describe('SessionService', () => {
  it('lists discovered sessions, annotates links and opens them as imported conversations', async () => {
    const { sessions, engine, repositories, workingDirectory } = await setup()
    engine.rpcResults.list_sessions = [
      { sessionId: '11111111-1111-4111-8111-111111111111', summary: 'Refonte API', lastModified: 1000, cwd: workingDirectory },
      { sessionId: '22222222-2222-4222-8222-222222222222', summary: 'Ancien projet', lastModified: 500, cwd: 'C:\\does\\not\\exist' }
    ]
    const listed = await sessions.list(true)
    expect(listed.sessions.map((session) => session.cwdExists)).toEqual([true, false])
    const conversation = await sessions.open('11111111-1111-4111-8111-111111111111')
    expect(conversation).toMatchObject({ origin: 'imported', claudeSessionId: '11111111-1111-4111-8111-111111111111', title: 'Refonte API', workingDirectory })
    // Opening again returns the same conversation (no duplicate).
    expect((await sessions.open('11111111-1111-4111-8111-111111111111')).id).toBe(conversation.id)
    expect(repositories.conversations.list(true)).toHaveLength(2)
    const relisted = await sessions.list(true)
    expect(relisted.sessions[0]?.linkedConversationId).toBe(conversation.id)
    await expect(sessions.open('22222222-2222-4222-8222-222222222222')).rejects.toThrow(/Reprise impossible/)
  })

  it('reports discovery errors without throwing', async () => {
    const { sessions } = await setup()
    const result = await sessions.list(true)
    expect(result.error).toBe('no result')
  })

  it('builds compact titles', () => {
    expect(sessionTitle({ sessionId: 'abcdef123', summary: '', customTitle: undefined, firstPrompt: undefined })).toBe('Session abcdef12')
    expect(sessionTitle({ sessionId: 'x', summary: 'résumé', customTitle: 'Titre perso', firstPrompt: 'p' })).toBe('Titre perso')
  })
})
