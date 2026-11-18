import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseModManifest, slashCommandProblem, toModEvents, type EngineEventLike } from '../../src/shared/aetherMods'
import { changedModFolder, watchModsFolder } from '../../src/main/mods/modWatcher'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = { id: 'demo', name: 'Démo', version: '1.0.0', permissions: [], commands: [] }

describe('mod manifests — embeds and new permissions', () => {
  it('accepts the three embeds and the action permissions', () => {
    const parsed = parseModManifest({
      ...base,
      permissions: ['events.read', 'composer.write', 'panels.open', 'commands.run'],
      panels: [
        { id: 'list', title: 'L', entry: 'a.html', embed: 'conversation-list' },
        { id: 'strip', title: 'S', entry: 'b.html', embed: 'composer-top', embedHeight: 32 },
        { id: 'page', title: 'P', entry: 'c.html', embed: 'page' }
      ],
      commands: [{ name: 'demo', opensPanel: 'page' }]
    })
    expect(parsed.ok).toBe(true)
  })

  it('refuses an unknown embed and a command opening a strip', () => {
    expect(parseModManifest({ ...base, panels: [{ id: 'x', title: 'X', entry: 'a.html', embed: 'titlebar' }] }).ok).toBe(false)
    expect(parseModManifest({ ...base, panels: [{ id: 'x', title: 'X', entry: 'a.html', embed: 'composer-top' }], commands: [{ name: 'x', opensPanel: 'x' }] }).ok).toBe(false)
  })
})

describe('slash commands a mod may send', () => {
  it('accepts one-line slash commands only', () => {
    expect(slashCommandProblem('/compact')).toBeNull()
    expect(slashCommandProblem('/eco-tokens on')).toBeNull()
    expect(slashCommandProblem('/ecc:plan fais un plan')).toBeNull()
    expect(slashCommandProblem('supprime tout')).not.toBeNull()
    expect(slashCommandProblem('/a\nrm -rf')).not.toBeNull()
    expect(slashCommandProblem(`/x ${'a'.repeat(600)}`)).not.toBeNull()
  })
})

describe('activity given to mods', () => {
  const at = 1000
  const convert = (event: EngineEventLike, seen = new Set<string>()) => toModEvents(event, at, seen)

  it('reports tool calls once, by name only, never their input', () => {
    const seen = new Set<string>()
    const message = { type: 'assistant_message', conversationId: 'c', parentToolUseId: null, blocks: [{ kind: 'text', text: 'secret' }, { kind: 'tool_use', toolUseId: 't1', toolName: 'Bash', input: { command: 'cat .env' } }] }
    const first = convert(message, seen)
    expect(first).toEqual([{ at, conversationId: 'c', type: 'tool_use', toolUseId: 't1', toolName: 'Bash', subagent: false }])
    expect(JSON.stringify(first)).not.toContain('.env')
    expect(convert(message, seen)).toEqual([])
  })

  it('keeps tool results to their status and turn results to numbers', () => {
    expect(convert({ type: 'tool_result', conversationId: 'c', toolUseId: 't1', content: 'mot de passe', isError: true })).toEqual([{ at, conversationId: 'c', type: 'tool_result', toolUseId: 't1', isError: true }])
    const [turn] = convert({ type: 'turn_result', conversationId: 'c', sessionId: 's', result: { isError: false, durationMs: 1200, model: 'm', totalCostUsd: 0.02, inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6, resultText: 'réponse privée' } })
    expect(turn).toMatchObject({ type: 'turn_end', durationMs: 1200, model: 'm', costUsd: 0.02, outputTokens: 4 })
    expect(JSON.stringify(turn)).not.toContain('privée')
  })

  it('ignores text deltas, logs and events without a conversation', () => {
    expect(convert({ type: 'text_delta', conversationId: 'c', text: 'Bonjour' })).toEqual([])
    expect(convert({ type: 'log', message: 'x' })).toEqual([])
    expect(convert({ type: 'runner_state', conversationId: 'c', state: 'running' })).toEqual([{ at, conversationId: 'c', type: 'runner_state', state: 'running' }])
  })
})

describe('mods folder watcher', () => {
  afterEach(() => vi.useRealTimers())

  it('names the mod folder of a changed file', () => {
    expect(changedModFolder('arbo\\panel.js')).toBe('arbo')
    expect(changedModFolder('tokens/sub/x.css')).toBe('tokens')
    expect(changedModFolder(null)).toBeNull()
  })

  it('reports one change per burst and per folder', () => {
    vi.useFakeTimers()
    let emit: ((eventType: string, fileName: string | null) => void) | null = null
    const onChange = vi.fn()
    const watcher = watchModsFolder({
      directory: join(tmpdir(), 'aether-mod-watch-test'),
      onChange,
      debounceMs: 100,
      watchImpl: (_directory, listener) => {
        emit = listener
        return { close: () => undefined }
      }
    })
    emit!('change', 'demo\\panel.js')
    emit!('change', 'demo\\panel.css')
    emit!('rename', 'other\\aether-mod.json')
    vi.advanceTimersByTime(150)
    expect(onChange.mock.calls).toEqual([['demo'], ['other']])
    watcher.close()
  })
})
