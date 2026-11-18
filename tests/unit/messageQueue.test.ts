import { beforeEach, describe, expect, it, vi } from 'vitest'
import { combineQueued, flushQueue, handleQueueEvent, queueFlushPoint, useMessageQueue } from '../../src/renderer/src/stores/messageQueue'

const image = { mediaType: 'image/png' as const, data: 'AAAA', preview: 'data:image/png;base64,AAAA' }

beforeEach(() => useMessageQueue.setState({ queues: {}, interrupting: {} }))

describe('message queue', () => {
  it('sends several queued messages as one, images included', () => {
    expect(combineQueued([{ id: '1', text: 'Et ajoute des tests.', images: [] }, { id: '2', text: '  Regarde aussi ça  ', images: [image] }])).toEqual({ text: 'Et ajoute des tests.\n\nRegarde aussi ça', images: [image] })
  })

  it('hands the queue over at a tool result or at the end of the turn, not on other events', () => {
    expect(queueFlushPoint({ type: 'tool_result', conversationId: 'c', toolUseId: 't', content: '', isError: false })).toBe('c')
    expect(queueFlushPoint({ type: 'runner_state', conversationId: 'c', state: 'idle' })).toBe('c')
    expect(queueFlushPoint({ type: 'runner_state', conversationId: 'c', state: 'running' })).toBeNull()
    expect(queueFlushPoint({ type: 'text_delta', conversationId: 'c', streamKey: 's', blockIndex: 0, text: 'x', thinking: false })).toBeNull()
  })

  it('empties the queue once sent, and puts it back in order when the send is refused', async () => {
    const store = useMessageQueue.getState()
    store.enqueue('c', { text: 'un', images: [] })
    store.enqueue('c', { text: 'deux', images: [] })
    const refuse = vi.fn(async () => false)
    await flushQueue('c', refuse)
    expect(refuse).toHaveBeenCalledWith('c', 'un\n\ndeux', [])
    expect(useMessageQueue.getState().queues.c?.map((item) => item.text)).toEqual(['un', 'deux'])
    const accept = vi.fn(async () => true)
    await flushQueue('c', accept)
    expect(useMessageQueue.getState().queues.c).toEqual([])
  })

  it('“interrupt and send” waits for Claude to stop, then sends first', async () => {
    const store = useMessageQueue.getState()
    store.enqueue('c', { text: 'plus tard', images: [] })
    store.enqueue('c', { text: 'urgent', images: [] }, true)
    store.setInterrupting('c', true)
    const send = vi.fn(async () => true)
    handleQueueEvent({ type: 'tool_result', conversationId: 'c', toolUseId: 't', content: '', isError: false }, send)
    expect(send).not.toHaveBeenCalled()
    handleQueueEvent({ type: 'runner_state', conversationId: 'c', state: 'idle' }, send)
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('c', 'urgent\n\nplus tard', []))
    expect(useMessageQueue.getState().interrupting.c).toBe(false)
  })

  it('takes a message out to edit it', () => {
    const store = useMessageQueue.getState()
    store.enqueue('c', { text: 'à corriger', images: [] })
    const id = useMessageQueue.getState().queues.c?.[0]?.id ?? ''
    expect(useMessageQueue.getState().take('c', id)?.text).toBe('à corriger')
    expect(useMessageQueue.getState().queues.c).toEqual([])
  })
})

describe('interrupted turns', () => {
  it('shows a stopped turn as a notice, not as an error', async () => {
    const { applyEngineEvent } = await import('../../src/shared/timeline')
    const result = { subtype: 'error_during_execution', isError: true, durationMs: 1, totalCostUsd: null, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], resultText: null, apiErrorStatus: null, model: null }
    const stopped = applyEngineEvent([], { type: 'turn_result', conversationId: 'c', sessionId: 's', result: { ...result, interrupted: true } }, 1)
    expect(stopped.find((item) => item.kind === 'system')).toMatchObject({ text: 'Tour interrompu.', tone: 'info' })
    const crashed = applyEngineEvent([], { type: 'turn_result', conversationId: 'c', sessionId: 's', result }, 1)
    expect(crashed.find((item) => item.kind === 'system')).toMatchObject({ tone: 'error' })
  })
})
