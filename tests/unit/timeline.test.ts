import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../../src/shared/domain'
import { applyEngineEvent, describeToolCall, stringifyToolResultContent, timelineFromHistory } from '../../src/shared/timeline'

describe('timelineFromHistory', () => {
  it('converts a Claude Code transcript into display items', () => {
    const items = timelineFromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Liste les fichiers' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', model: 'model-a', content: [{ type: 'text', text: 'Je regarde.' }] } },
      { type: 'assistant', uuid: 'a2', message: { id: 'msg_1', model: 'model-a', content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'dir' } }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: [{ type: 'text', text: 'a.txt' }] }] } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'assistant', uuid: 'a3', message: { id: 'msg_2', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Il y a a.txt' }] } }
    ])
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
    const first = items[1]
    expect(first?.kind === 'assistant' && first.blocks).toEqual([
      { kind: 'text', text: 'Je regarde.' },
      { kind: 'tool_use', toolUseId: 'tool_1', toolName: 'Bash', input: { command: 'dir' } }
    ])
    expect(items[2]).toMatchObject({ toolUseId: 'tool_1', content: 'a.txt', isError: false })
    const last = items[3]
    expect(last?.kind === 'assistant' && last.blocks[0]).toEqual({ kind: 'thinking', text: 'hmm' })
  })
})

describe('applyEngineEvent', () => {
  it('streams deltas into a single assistant item then finalises it', () => {
    let items: TimelineItem[] = [{ kind: 'user', id: 'u', text: 'hi', timestamp: 1 }]
    items = applyEngineEvent(items, { type: 'text_delta', conversationId: 'c', streamKey: 'msg', blockIndex: 0, text: 'Bon', thinking: false }, 2)
    items = applyEngineEvent(items, { type: 'text_delta', conversationId: 'c', streamKey: 'msg', blockIndex: 0, text: 'jour', thinking: false }, 3)
    expect(items[1]).toMatchObject({ kind: 'assistant', streaming: true, blocks: [{ kind: 'text', text: 'Bonjour' }] })
    items = applyEngineEvent(items, { type: 'assistant_message', conversationId: 'c', messageId: 'msg', blocks: [{ kind: 'text', text: 'Bonjour !' }], model: 'model-a', error: null, parentToolUseId: null }, 4)
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ blocks: [{ kind: 'text', text: 'Bonjour !' }], model: 'model-a' })
    items = applyEngineEvent(items, { type: 'turn_result', conversationId: 'c', sessionId: 's', result: { subtype: 'success', isError: false, durationMs: 10, totalCostUsd: 0.01, inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, errors: [], resultText: 'Bonjour !', apiErrorStatus: null, model: 'model-a' } }, 5)
    expect(items[1]).toMatchObject({ streaming: false })
    expect(items[2]).toMatchObject({ kind: 'turn_summary', inputTokens: 1, outputTokens: 2 })
  })

  it('shows engine errors as system items and keeps tool results unique', () => {
    let items: TimelineItem[] = []
    items = applyEngineEvent(items, { type: 'tool_result', conversationId: 'c', toolUseId: 't', content: 'ok', isError: false }, 1)
    items = applyEngineEvent(items, { type: 'tool_result', conversationId: 'c', toolUseId: 't', content: 'ok', isError: false }, 2)
    expect(items).toHaveLength(1)
    items = applyEngineEvent(items, { type: 'runner_state', conversationId: 'c', state: 'error', message: 'Moteur arrêté' }, 3)
    expect(items[1]).toMatchObject({ kind: 'system', tone: 'error', text: 'Moteur arrêté' })
    items = applyEngineEvent(items, { type: 'assistant_message', conversationId: 'c', messageId: 'm', blocks: [{ kind: 'text', text: "You've hit your limit" }], model: null, error: 'rate_limit', parentToolUseId: null }, 4)
    expect(items.at(-1)).toMatchObject({ kind: 'system', tone: 'error', text: 'rate_limit' })
  })
})

describe('helpers', () => {
  it('describes tool calls', () => {
    expect(describeToolCall('Bash', { command: 'npm test' })).toBe('npm test')
    expect(describeToolCall('Edit', { file_path: 'C:\\a.ts' })).toBe('C:\\a.ts')
    expect(describeToolCall('Grep', { pattern: 'todo', path: 'src' })).toBe('todo — src')
    expect(describeToolCall('mcp__x__y', {})).toBe('mcp__x__y')
  })

  it('flattens tool result content', () => {
    expect(stringifyToolResultContent('plain')).toBe('plain')
    expect(stringifyToolResultContent([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe('a\n[image]')
    expect(stringifyToolResultContent({ value: 1 })).toContain('"value": 1')
  })
})
