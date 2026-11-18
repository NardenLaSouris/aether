/**
 * Pure conversion of Claude Code messages into display timeline items,
 * and a reducer that applies live engine events to a timeline.
 */
import type { AssistantBlock, TimelineItem } from './domain'
import type { EngineEvent } from './engineProtocol'

interface ContentBlockLike {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Flatten a tool_result `content` field (string or array of text/image blocks) into text. */
export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isRecord(part)) {
          if (part.type === 'text' && typeof part.text === 'string') return part.text
          if (part.type === 'image') return '[image]'
        }
        return typeof part === 'string' ? part : ''
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

/** Convert API content blocks of an assistant message into AssistantBlocks. */
export function toAssistantBlocks(content: unknown): AssistantBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ kind: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: AssistantBlock[] = []
  for (const rawBlock of content as ContentBlockLike[]) {
    if (!isRecord(rawBlock)) continue
    if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') blocks.push({ kind: 'text', text: rawBlock.text })
    else if (rawBlock.type === 'thinking' && typeof rawBlock.thinking === 'string' && rawBlock.thinking.length > 0) blocks.push({ kind: 'thinking', text: rawBlock.thinking })
    else if ((rawBlock.type === 'tool_use' || rawBlock.type === 'server_tool_use' || rawBlock.type === 'mcp_tool_use') && typeof rawBlock.id === 'string') {
      blocks.push({ kind: 'tool_use', toolUseId: rawBlock.id, toolName: typeof rawBlock.name === 'string' ? rawBlock.name : 'outil', input: rawBlock.input ?? {} })
    }
  }
  return blocks
}

/** Extract text typed by the user from a user MessageParam content (ignores tool_result blocks). */
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentBlockLike[])
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

export interface HistoryMessageLike {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id?: string | null
}

/** Strip Claude Code's internal wrappers so that command echoes do not appear as user prompts. */
function isInternalUserText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<command-') || trimmed.startsWith('<local-command-') || trimmed.startsWith('<system-reminder>') || trimmed.startsWith('Caveat: The messages below')
}

/** Build a timeline from a transcript returned by the official `getSessionMessages()`. */
export function timelineFromHistory(messages: HistoryMessageLike[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const assistantIndexByMessageId = new Map<string, number>()
  let sequence = 0
  for (const entry of messages) {
    sequence += 1
    const timestamp = sequence
    const message = isRecord(entry.message) ? entry.message : {}
    if (entry.type === 'user') {
      const content = message.content
      if (Array.isArray(content)) {
        for (const block of content as ContentBlockLike[]) {
          if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            items.push({ kind: 'tool_result', id: `${entry.uuid}:${block.tool_use_id}`, toolUseId: block.tool_use_id, content: stringifyToolResultContent(block.content), isError: block.is_error === true, timestamp })
          }
        }
      }
      const text = extractUserText(content)
      if (text.trim().length > 0 && !isInternalUserText(text) && !entry.parent_tool_use_id) items.push({ kind: 'user', id: entry.uuid, text, timestamp })
    } else if (entry.type === 'assistant') {
      const apiMessageId = typeof message.id === 'string' ? message.id : entry.uuid
      const blocks = toAssistantBlocks(message.content)
      if (blocks.length === 0) continue
      const existingIndex = assistantIndexByMessageId.get(apiMessageId)
      const existing = existingIndex !== undefined ? items[existingIndex] : undefined
      if (existing && existing.kind === 'assistant') {
        existing.blocks = [...existing.blocks, ...blocks]
      } else {
        assistantIndexByMessageId.set(apiMessageId, items.length)
        items.push({ kind: 'assistant', id: apiMessageId, blocks, model: typeof message.model === 'string' ? message.model : null, timestamp, streaming: false, parentToolUseId: entry.parent_tool_use_id ?? null })
      }
    }
  }
  return items
}

function updateItem(items: TimelineItem[], index: number, item: TimelineItem): TimelineItem[] {
  const copy = items.slice()
  copy[index] = item
  return copy
}

/** Apply one live engine event to a timeline. Unknown events leave the timeline unchanged. */
export function applyEngineEvent(items: TimelineItem[], event: EngineEvent, now: number): TimelineItem[] {
  switch (event.type) {
    case 'text_delta': {
      const index = items.findIndex((item) => item.kind === 'assistant' && item.id === event.streamKey)
      if (index === -1) {
        const blocks: AssistantBlock[] = []
        blocks[event.blockIndex] = event.thinking ? { kind: 'thinking', text: event.text } : { kind: 'text', text: event.text }
        return [...items, { kind: 'assistant', id: event.streamKey, blocks: fillHoles(blocks), model: null, timestamp: now, streaming: true, parentToolUseId: null }]
      }
      const current = items[index]
      if (!current || current.kind !== 'assistant') return items
      const blocks = current.blocks.slice()
      const target = blocks[event.blockIndex]
      if (target && (target.kind === 'text' || target.kind === 'thinking')) {
        blocks[event.blockIndex] = { ...target, text: target.text + event.text }
      } else if (!target) {
        blocks[event.blockIndex] = event.thinking ? { kind: 'thinking', text: event.text } : { kind: 'text', text: event.text }
      }
      return updateItem(items, index, { ...current, blocks: fillHoles(blocks), streaming: true })
    }
    case 'assistant_message': {
      const index = items.findIndex((item) => item.kind === 'assistant' && item.id === event.messageId)
      const nextItem: TimelineItem = {
        kind: 'assistant',
        id: event.messageId,
        blocks: event.blocks,
        model: event.model,
        timestamp: index === -1 ? now : (items[index]?.timestamp ?? now),
        streaming: index === -1 ? false : true,
        parentToolUseId: event.parentToolUseId
      }
      const withMessage = index === -1 ? [...items, nextItem] : updateItem(items, index, nextItem)
      if (event.error) return [...withMessage, { kind: 'system', id: `${event.messageId}:error`, text: event.error, tone: 'error', timestamp: now }]
      return withMessage
    }
    case 'tool_result':
      if (items.some((item) => item.kind === 'tool_result' && item.toolUseId === event.toolUseId)) return items
      return [...items, { kind: 'tool_result', id: `result:${event.toolUseId}`, toolUseId: event.toolUseId, content: event.content, isError: event.isError, timestamp: now }]
    case 'turn_result': {
      const settled = items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))
      const summary: TimelineItem = {
        kind: 'turn_summary',
        id: `turn:${now}:${settled.length}`,
        durationMs: event.result.durationMs,
        costUsd: event.result.totalCostUsd,
        inputTokens: event.result.inputTokens,
        outputTokens: event.result.outputTokens,
        isError: event.result.isError,
        timestamp: now
      }
      // A turn the user stopped ends "during execution": a notice, not an error.
      const interrupted = event.result.interrupted === true && event.result.subtype !== 'success'
      if (interrupted) return [...settled, { kind: 'system', id: `${summary.id}:interrupted`, text: 'Tour interrompu.', tone: 'info', timestamp: now }, { ...summary, isError: false }]
      const errorText = event.result.isError ? (event.result.errors.join('\n') || event.result.resultText || `Le tour s’est terminé avec une erreur (${event.result.subtype}).`) : null
      return errorText ? [...settled, { kind: 'system', id: `${summary.id}:error`, text: errorText, tone: 'error', timestamp: now }, summary] : [...settled, summary]
    }
    case 'engine_notice':
      return [...items, { kind: 'system', id: `notice:${now}:${items.length}`, text: event.text, tone: event.tone, timestamp: now }]
    case 'api_retry':
      return [...items, { kind: 'system', id: `retry:${now}:${event.attempt}`, text: `Nouvelle tentative ${event.attempt}/${event.maxRetries} dans ${Math.round(event.retryDelayMs / 1000)} s (${event.error}${event.errorStatus ? `, HTTP ${event.errorStatus}` : ''}).`, tone: 'warning', timestamp: now }]
    case 'runner_state':
      if (event.state === 'error' && event.message) return [...items, { kind: 'system', id: `state:${now}:${items.length}`, text: event.message, tone: 'error', timestamp: now }]
      if (event.state === 'idle' || event.state === 'closed' || event.state === 'error') {
        return items.some((item) => item.kind === 'assistant' && item.streaming) ? items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item)) : items
      }
      return items
    default:
      return items
  }
}

function fillHoles(blocks: AssistantBlock[]): AssistantBlock[] {
  const filled: AssistantBlock[] = []
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) filled.push(blocks[blockIndex] ?? { kind: 'text', text: '' })
  return filled
}

/** Short one-line description of a tool call for headers and permission dialogs. */
export function describeToolCall(toolName: string, input: unknown): string {
  const record = isRecord(input) ? input : {}
  const pick = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null)
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return pick('command') ?? toolName
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('file_path') ?? pick('notebook_path') ?? toolName
    case 'Glob':
    case 'Grep':
      return [pick('pattern'), pick('path')].filter(Boolean).join(' — ') || toolName
    case 'WebFetch':
      return pick('url') ?? toolName
    case 'WebSearch':
      return pick('query') ?? toolName
    case 'Task':
    case 'Agent':
      return pick('description') ?? toolName
    default:
      return pick('description') ?? pick('path') ?? pick('file_path') ?? toolName
  }
}

/** What a tool can do, shown in the permission dialog. Informational only. */
export function describeToolConsequences(toolName: string): string {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return 'Exécute une commande dans un shell sur votre machine, avec vos droits utilisateur. Elle peut lire, modifier ou supprimer des fichiers et accéder au réseau.'
    case 'Write':
      return 'Crée ou remplace entièrement un fichier sur le disque.'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Modifie le contenu d’un fichier existant.'
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'Lit des fichiers ou explore l’arborescence. Aucune modification.'
    case 'WebFetch':
    case 'WebSearch':
      return 'Accède à Internet pour récupérer des informations.'
    default:
      return toolName.startsWith('mcp__') ? 'Appelle un outil fourni par un serveur MCP configuré dans Claude Code.' : 'Outil Claude Code. Consultez les paramètres ci-dessous.'
  }
}

// ---------------------------------------------------------------------------
// Claude's task list (TodoWrite, or the newer TaskCreate / TaskUpdate tools), as it stands now.

export interface TodoEntry {
  id: string
  content: string
  /** Shown while the task is in progress ("Lancement des tests"). */
  activeForm: string | null
  status: 'pending' | 'in_progress' | 'completed'
}

function todoStatus(value: unknown): TodoEntry['status'] | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
}

/**
 * The current task list of a conversation's timeline, or null when Claude never made one.
 * Subagents' lists are ignored: only the main conversation's.
 */
export function deriveTodos(items: TimelineItem[]): TodoEntry[] | null {
  const results = new Map<string, string>()
  for (const item of items) if (item.kind === 'tool_result' && !item.isError) results.set(item.toolUseId, item.content)
  let todos = null as TodoEntry[] | null
  let created = 0
  for (const item of items) {
    if (item.kind !== 'assistant' || item.parentToolUseId) continue
    for (const block of item.blocks) {
      if (block.kind !== 'tool_use') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      if (block.toolName === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos.flatMap((raw, index): TodoEntry[] => {
          const entry = (raw ?? {}) as Record<string, unknown>
          const status = todoStatus(entry.status)
          if (typeof entry.content !== 'string' || !status) return []
          return [{ id: String(index + 1), content: entry.content, activeForm: typeof entry.activeForm === 'string' ? entry.activeForm : null, status }]
        })
      } else if (block.toolName === 'TaskCreate' && typeof input.subject === 'string') {
        created += 1
        const fromResult = /#?(\d+)/.exec(results.get(block.toolUseId) ?? '')?.[1]
        const id = fromResult ?? String(created)
        todos = [...(todos ?? []).filter((todo) => todo.id !== id), { id, content: input.subject, activeForm: typeof input.activeForm === 'string' ? input.activeForm : null, status: 'pending' }]
      } else if (block.toolName === 'TaskUpdate' && typeof input.taskId === 'string' && todos) {
        const taskId = input.taskId.replace(/^#/, '')
        if (input.status === 'deleted') {
          todos = todos.filter((todo) => todo.id !== taskId)
          continue
        }
        const status = todoStatus(input.status)
        todos = todos.map((todo) =>
          todo.id === taskId
            ? { ...todo, ...(status ? { status } : {}), ...(typeof input.subject === 'string' ? { content: input.subject } : {}), ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : {}) }
            : todo
        )
      }
    }
  }
  return todos
}
