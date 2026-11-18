import { describe, expect, it } from 'vitest'
import { ConversationRunner } from '../../src/engine-host/conversationRunner'
import type { EngineEvent, StartRunnerCommand } from '../../src/shared/engineProtocol'
import { createFakeQueryFactory, flushPromises } from './helpers/fakeQuery'

function makeRunner(overrides: Partial<StartRunnerCommand> = {}) {
  const { factory, handles } = createFakeQueryFactory()
  const events: EngineEvent[] = []
  const command: StartRunnerCommand = {
    type: 'start_runner',
    conversationId: 'conversation-1',
    executablePath: 'C:\\claude.exe',
    workingDirectory: 'C:\\project',
    model: null,
    permissionMode: 'default',
    resumeSessionId: null,
    ...overrides
  }
  const runner = new ConversationRunner(command, { queryFactory: factory, emit: (event) => events.push(event) })
  return { runner, handles, events }
}

describe('ConversationRunner — session creation and options', () => {
  it('starts a new session with explicit default permissions and the official executable', () => {
    const { runner, handles } = makeRunner()
    runner.start()
    const options = handles[0]?.options
    expect(options?.pathToClaudeCodeExecutable).toBe('C:\\claude.exe')
    expect(options?.cwd).toBe('C:\\project')
    expect(options?.permissionMode).toBe('default')
    expect(options?.resume).toBeUndefined()
    expect(options?.includePartialMessages).toBe(true)
    expect(options?.canUseTool).toBeTypeOf('function')
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('allows skipping permissions only for a session the user launched in "tout autoriser"', () => {
    const { runner, handles } = makeRunner({ permissionMode: 'bypassPermissions' })
    runner.start()
    expect(handles[0]?.options.permissionMode).toBe('bypassPermissions')
    expect(handles[0]?.options.allowDangerouslySkipPermissions).toBe(true)
  })

  it('resumes an existing session through the official resume option', () => {
    const { runner, handles } = makeRunner({ resumeSessionId: '11111111-2222-3333-4444-555555555555', model: 'model-a' })
    runner.start()
    expect(handles[0]?.options.resume).toBe('11111111-2222-3333-4444-555555555555')
    expect(handles[0]?.options.model).toBe('model-a')
    expect(runner.claudeSessionId).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('records the session id announced by system/init', async () => {
    const { runner, handles, events } = makeRunner()
    runner.send('Bonjour', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    handles[0]?.emit({ type: 'system', subtype: 'init', session_id: 'session-xyz', model: 'model-a', cwd: 'C:\\project', tools: ['Read'], permissionMode: 'default', claude_code_version: '2.1.0' })
    await flushPromises()
    expect(runner.claudeSessionId).toBe('session-xyz')
    expect(events.find((event) => event.type === 'session_init')).toMatchObject({ sessionId: 'session-xyz', model: 'model-a' })
    expect(handles[0]?.receivedPrompts[0]?.message).toEqual({ role: 'user', content: 'Bonjour' })
  })
})

describe('ConversationRunner — streaming', () => {
  it('reports token usage live, as increments, for the conversation and its subagents', async () => {
    const { runner, handles, events } = makeRunner()
    runner.send('Salut', 'x')
    const fake = handles[0]
    fake?.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', model: 'model-a', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 900 } } }, parent_tool_use_id: null })
    fake?.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_s', model: 'model-b', usage: { input_tokens: 5, output_tokens: 0 } } }, parent_tool_use_id: 'tool_9' })
    fake?.emit({ type: 'stream_event', event: { type: 'message_delta', delta: {}, usage: { output_tokens: 250 } }, parent_tool_use_id: null })
    fake?.emit({ type: 'stream_event', event: { type: 'message_delta', delta: {}, usage: { input_tokens: 12, output_tokens: 250, cache_read_input_tokens: 40_000 } }, parent_tool_use_id: null })
    fake?.emit({ type: 'stream_event', event: { type: 'message_delta', delta: {}, usage: { output_tokens: 30 } }, parent_tool_use_id: 'tool_9' })
    await flushPromises()
    const usage = events.filter((event) => event.type === 'token_usage')
    expect(usage).toEqual([
      { type: 'token_usage', conversationId: 'conversation-1', model: 'model-a', inputTokens: 12, outputTokens: 1, cacheReadInputTokens: 40_000, cacheCreationInputTokens: 900, subagent: false },
      { type: 'token_usage', conversationId: 'conversation-1', model: 'model-b', inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, subagent: true },
      { type: 'token_usage', conversationId: 'conversation-1', model: 'model-a', inputTokens: 0, outputTokens: 249, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, subagent: false },
      { type: 'token_usage', conversationId: 'conversation-1', model: 'model-b', inputTokens: 0, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, subagent: true }
    ])
  })

  it('emits text deltas, the full assistant message, tool results and the turn result', async () => {
    const { runner, handles, events } = makeRunner()
    runner.send('Salut', 'x')
    const fake = handles[0]
    fake?.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } }, parent_tool_use_id: null })
    fake?.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bon' } }, parent_tool_use_id: null })
    fake?.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'jour' } }, parent_tool_use_id: null })
    fake?.emit({ type: 'assistant', uuid: 'u1', session_id: 's', parent_tool_use_id: null, message: { id: 'msg_1', model: 'model-a', content: [{ type: 'text', text: 'Bonjour' }] } })
    fake?.emit({ type: 'assistant', uuid: 'u2', session_id: 's', parent_tool_use_id: null, message: { id: 'msg_1', model: 'model-a', content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'a.txt' } }] } })
    fake?.emit({ type: 'user', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'contenu', is_error: false }] } })
    fake?.emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }, errors: [], result: 'Bonjour', session_id: 'session-1' })
    await flushPromises()

    const deltas = events.filter((event) => event.type === 'text_delta')
    expect(deltas.map((event) => (event.type === 'text_delta' ? event.text : ''))).toEqual(['Bon', 'jour'])
    const assistant = events.filter((event) => event.type === 'assistant_message')
    expect(assistant).toHaveLength(2)
    // The second assistant message carries the accumulated blocks of the same API message.
    expect(assistant[1]).toMatchObject({ messageId: 'msg_1', blocks: [{ kind: 'text', text: 'Bonjour' }, { kind: 'tool_use', toolUseId: 'tool_1', toolName: 'Read' }] })
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ toolUseId: 'tool_1', content: 'contenu', isError: false })
    const result = events.find((event) => event.type === 'turn_result')
    expect(result).toMatchObject({ sessionId: 'session-1', result: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, isError: false } })
    expect(runner.state).toBe('idle')
  })

  it('forwards rate limit events untouched', async () => {
    const { runner, handles, events } = makeRunner()
    runner.send('x', 'x')
    handles[0]?.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour', utilization: 1 }, session_id: 's', uuid: 'u' })
    await flushPromises()
    expect(events.find((event) => event.type === 'rate_limit')).toMatchObject({ info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } })
  })

  it('forwards what the mods report: status line, toast, panes and log', async () => {
    const { runner, handles, events } = makeRunner()
    runner.send('x', 'x')
    handles[0]?.emit({ type: 'system', subtype: 'ui_status', plugin: 'token-saver', text: 'éco-tokens : ~0k tokens évités', uuid: 'u', session_id: 's' })
    handles[0]?.emit({ type: 'system', subtype: 'ui_status', plugin: 'auto-model', text: null, uuid: 'u', session_id: 's' })
    handles[0]?.emit({ type: 'system', subtype: 'ui_toast', plugin: 'session-chat', text: 'Message reçu', timeout_ms: 4000, uuid: 'u', session_id: 's' })
    handles[0]?.emit({ type: 'system', subtype: 'ui_toast', plugin: 'session-chat', text: '   ', uuid: 'u', session_id: 's' })
    handles[0]?.emit({ type: 'system', subtype: 'ui_panes', panes: [{ id: 'git-tree', title: 'Dépôt git', plugin: 'git-tree' }, { title: 'sans id' }, 'not a pane'], shown_id: 'git-tree', uuid: 'u', session_id: 's' })
    handles[0]?.emit({ type: 'system', subtype: 'ui_log', plugin: 'git-tree', text: 'refresh', uuid: 'u', session_id: 's' })
    await flushPromises()
    expect(events.filter((event) => event.type === 'mod_status')).toEqual([
      { type: 'mod_status', conversationId: 'conversation-1', plugin: 'token-saver', text: 'éco-tokens : ~0k tokens évités' },
      { type: 'mod_status', conversationId: 'conversation-1', plugin: 'auto-model', text: null }
    ])
    expect(events.filter((event) => event.type === 'mod_toast')).toEqual([{ type: 'mod_toast', conversationId: 'conversation-1', plugin: 'session-chat', text: 'Message reçu' }])
    expect(events.find((event) => event.type === 'mod_panes')).toEqual({ type: 'mod_panes', conversationId: 'conversation-1', panes: [{ id: 'git-tree', title: 'Dépôt git', plugin: 'git-tree' }] })
    expect(events.find((event) => event.type === 'log' && event.message === '[mod git-tree]')).toMatchObject({ details: 'refresh' })
  })

  it('does not report "<synthetic>" (a local command reply) as a model', async () => {
    const { runner, handles, events } = makeRunner({ model: 'model-a' })
    runner.send('/eco-tokens', 'x')
    handles[0]?.emit({ type: 'assistant', uuid: 'u1', session_id: 's', parent_tool_use_id: null, message: { id: 'msg_s', model: '<synthetic>', content: [{ type: 'text', text: 'token-saver: activé' }] } })
    handles[0]?.emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 400, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, errors: [], result: '', session_id: 's' })
    await flushPromises()
    expect(events.find((event) => event.type === 'assistant_message')).toMatchObject({ model: null })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ result: { model: 'model-a' } })
  })

  it('reports an engine crash as an error state instead of throwing', async () => {
    const { runner, handles, events } = makeRunner()
    runner.send('x', 'x')
    handles[0]?.fail(new Error('process exited with code 1'))
    await runner.waitForCompletion()
    const last = events.filter((event) => event.type === 'runner_state').at(-1)
    expect(last).toMatchObject({ state: 'error' })
  })
})

describe('ConversationRunner — permissions', () => {
  async function requestPermission() {
    const context = makeRunner()
    context.runner.start()
    const canUseTool = context.handles[0]?.options.canUseTool
    if (!canUseTool) throw new Error('canUseTool missing')
    const controller = new AbortController()
    const decision = canUseTool('Bash', { command: 'rm -rf build' }, { signal: controller.signal, toolUseID: 'tool_9', requestId: 'request-1', title: 'Exécuter une commande' } as never)
    await flushPromises()
    return { ...context, decision, controller }
  }

  it('emits a permission request and resolves allow with the original input', async () => {
    const { runner, decision, events } = await requestPermission()
    const request = events.find((event) => event.type === 'permission_request')
    expect(request).toMatchObject({ requestId: 'request-1', toolName: 'Bash', input: { command: 'rm -rf build' }, title: 'Exécuter une commande' })
    expect(runner.pendingPermissionIds()).toEqual(['request-1'])
    runner.resolvePermission('request-1', true, undefined, runner.inputForRequest('request-1'))
    await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedInput: { command: 'rm -rf build' } })
  })

  it('resolves deny with the user message', async () => {
    const { runner, decision } = await requestPermission()
    runner.resolvePermission('request-1', false, 'Pas maintenant', undefined)
    await expect(decision).resolves.toMatchObject({ behavior: 'deny', message: 'Pas maintenant' })
  })

  it('cancels the request when the engine aborts it', async () => {
    const { decision, controller, events } = await requestPermission()
    controller.abort()
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
    expect(events.some((event) => event.type === 'permission_cancelled')).toBe(true)
  })

  it('interrupt denies pending permissions and calls the official interrupt', async () => {
    const { runner, decision, handles } = await requestPermission()
    await runner.interrupt()
    await expect(decision).resolves.toMatchObject({ behavior: 'deny', interrupt: true })
    expect(handles[0]?.calls.interrupt).toBe(1)
  })
})

describe('ConversationRunner — controls', () => {
  it('changes the model and permission mode on the live query', async () => {
    const { runner, handles } = makeRunner()
    runner.start()
    await runner.setModel('model-b')
    await runner.setModel(null)
    await runner.setPermissionMode('plan')
    expect(handles[0]?.calls.setModel).toEqual(['model-b', undefined])
    expect(handles[0]?.calls.setPermissionMode).toEqual(['plan'])
  })

  it('close ends the input stream and the query', async () => {
    const { runner, handles } = makeRunner()
    runner.start()
    runner.close()
    await runner.waitForCompletion()
    expect(handles[0]?.calls.close).toBe(1)
    expect(runner.state).toBe('closed')
    expect(() => runner.send('x', 'x')).toThrow()
  })
})
