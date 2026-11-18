/**
 * Conversation timeline: user prompts, assistant text, thinking, tool calls with their results, system notices.
 */
import { AlertTriangle, Brain, ChevronRight, FileEdit, FilePlus, FileText, Globe, Info, ListTodo, Search, Terminal, Wrench, XCircle } from 'lucide-react'
import { memo, useMemo, useState, type ReactNode } from 'react'
import type { AssistantBlock, TimelineItem } from '../../../shared/domain'
import { deriveTodos, describeToolCall } from '../../../shared/timeline'
import { TodoChecklist } from './TodoList'
import { openFileInViewer, RewindButton } from './ChangesPanel'
import { formatSeconds, formatTokens, formatUsd } from '../lib/format'
import { CopyButton, Markdown } from './Markdown'
import { classNames } from './ui'

function toolIcon(toolName: string): ReactNode {
  const iconClass = 'size-3.5'
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return <Terminal className={iconClass} />
    case 'Read':
      return <FileText className={iconClass} />
    case 'Write':
      return <FilePlus className={iconClass} />
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return <FileEdit className={iconClass} />
    case 'Glob':
    case 'Grep':
      return <Search className={iconClass} />
    case 'WebFetch':
    case 'WebSearch':
      return <Globe className={iconClass} />
    default:
      return <Wrench className={iconClass} />
  }
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function EditPreview({ input }: { input: Record<string, unknown> }) {
  const oldText = typeof input.old_string === 'string' ? input.old_string : null
  const newText = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : null
  if (newText === null) return null
  return (
    <div className="grid gap-1 font-mono text-[12px]">
      {oldText !== null && <pre className="max-h-60 overflow-auto rounded border border-danger/20 bg-danger/8 px-2.5 py-1.5 whitespace-pre-wrap text-[#e6b5aa]">{oldText.split('\n').map((line) => `- ${line}`).join('\n')}</pre>}
      <pre className="max-h-72 overflow-auto rounded border border-success/20 bg-success/8 px-2.5 py-1.5 whitespace-pre-wrap text-[#b9dcb9]">{newText.split('\n').map((line) => `${oldText !== null ? '+ ' : ''}${line}`).join('\n')}</pre>
    </div>
  )
}

/** TodoWrite as a checklist rather than a raw tool call. */
function TodoWriteCard({ input }: { input: unknown }) {
  const todos = deriveTodos([{ kind: 'assistant', id: 'todo', blocks: [{ kind: 'tool_use', toolUseId: 'todo', toolName: 'TodoWrite', input }], model: null, timestamp: 0, streaming: false, parentToolUseId: null }]) ?? []
  const done = todos.filter((todo) => todo.status === 'completed').length
  return (
    <div className="my-2 rounded-md border border-line bg-sunken/70 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[12px]">
        <ListTodo className="size-3.5 text-gold" />
        <span className="font-semibold text-ink">Tâches</span>
        <span className="text-ink-faint tabular-nums">
          {done}/{todos.length}
        </span>
      </div>
      <TodoChecklist todos={todos} />
    </div>
  )
}

export function ToolCallCard({ block, result }: { block: Extract<AssistantBlock, { kind: 'tool_use' }>; result?: Extract<TimelineItem, { kind: 'tool_result' }> }) {
  if (block.toolName === 'TodoWrite') return <TodoWriteCard input={block.input} />
  return <GenericToolCallCard block={block} result={result} />
}

function GenericToolCallCard({ block, result }: { block: Extract<AssistantBlock, { kind: 'tool_use' }>; result?: Extract<TimelineItem, { kind: 'tool_result' }> }) {
  const [expanded, setExpanded] = useState(false)
  const summary = describeToolCall(block.toolName, block.input)
  const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>
  const isEdit = ['Edit', 'Write', 'MultiEdit'].includes(block.toolName)
  const status = result ? (result.isError ? 'error' : 'done') : 'pending'
  return (
    <div className={classNames('my-2 overflow-hidden rounded-md border bg-sunken/70', status === 'error' ? 'border-danger/30' : 'border-line')}>
      <button type="button" onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/3">
        <ChevronRight className={classNames('size-3.5 shrink-0 text-ink-faint transition-transform', expanded && 'rotate-90')} />
        <span className={classNames('flex size-5 items-center justify-center rounded', status === 'error' ? 'bg-danger/15 text-danger' : 'bg-sage/15 text-sage')}>{toolIcon(block.toolName)}</span>
        <span className="text-[12.5px] font-semibold text-ink">{block.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">{summary !== block.toolName ? summary : ''}</span>
        {status === 'pending' && <span className="size-1.5 animate-pulse-soft rounded-full bg-gold" aria-label="En cours" />}
        {status === 'error' && <XCircle className="size-3.5 text-danger" />}
      </button>
      {expanded && (
        <div className="selectable space-y-2 border-t border-line px-3 py-2.5">
          {typeof input.file_path === 'string' && (
            <button type="button" onClick={() => openFileInViewer(input.file_path as string, typeof input.offset === 'number' ? input.offset : undefined)} className="flex items-center gap-1.5 text-[11.5px] text-sage hover:text-ink">
              <FileText className="size-3" /> Ouvrir le fichier
            </button>
          )}
          {isEdit ? <EditPreview input={input} /> : null}
          <details open={!isEdit}>
            <summary className="cursor-pointer text-[11px] text-ink-faint">Paramètres</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-black/20 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-muted">{formatInput(block.input)}</pre>
          </details>
          {result && (
            <div>
              <div className="flex items-center justify-between">
                <span className={classNames('text-[11px]', result.isError ? 'text-danger' : 'text-ink-faint')}>{result.isError ? 'Erreur de l’outil' : 'Résultat'}</span>
                <CopyButton text={result.content} />
              </div>
              <pre className="mt-1 max-h-96 overflow-auto rounded bg-black/20 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-muted">{result.content || '(vide)'}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-2 rounded-md border border-line/70 bg-white/[0.015]">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-faint hover:text-ink-muted">
        <Brain className={classNames('size-3.5', streaming && 'animate-pulse-soft text-gold')} />
        Réflexion {streaming ? 'en cours…' : ''}
        <ChevronRight className={classNames('ml-auto size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="selectable border-t border-line/70 px-3 py-2 text-[12.5px] whitespace-pre-wrap text-ink-muted italic">{text}</div>}
    </div>
  )
}

const AssistantMessage = memo(function AssistantMessage({ item, results }: { item: Extract<TimelineItem, { kind: 'assistant' }>; results: Map<string, Extract<TimelineItem, { kind: 'tool_result' }>> }) {
  const fullText = item.blocks
    .filter((block) => block.kind === 'text')
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('\n\n')
  return (
    <div className={classNames('group animate-fade-in', item.parentToolUseId && 'ml-6 border-l border-line pl-4 opacity-90')}>
      {item.parentToolUseId && <div className="mb-1 text-[11px] text-ink-faint">Sous-agent</div>}
      {item.blocks.map((block, blockIndex) => {
        if (block.kind === 'text') return block.text ? <Markdown key={blockIndex} text={block.text} /> : null
        if (block.kind === 'thinking') return <ThinkingBlock key={blockIndex} text={block.text} streaming={item.streaming && blockIndex === item.blocks.length - 1} />
        return <ToolCallCard key={block.toolUseId} block={block} result={results.get(block.toolUseId)} />
      })}
      {item.streaming && <span className="inline-block h-4 w-1.5 animate-pulse-soft bg-gold/80 align-middle" aria-label="Génération en cours" />}
      {!item.streaming && fullText && (
        <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={fullText} label="Copier la réponse" />
          {item.model && <span className="text-[11px] text-ink-faint">{item.model}</span>}
        </div>
      )}
    </div>
  )
})

export function Timeline({ items, conversationId }: { items: TimelineItem[]; conversationId?: string }) {
  const results = useMemo(() => {
    const map = new Map<string, Extract<TimelineItem, { kind: 'tool_result' }>>()
    for (const item of items) if (item.kind === 'tool_result') map.set(item.toolUseId, item)
    return map
  }, [items])
  const knownToolUses = useMemo(() => {
    const ids = new Set<string>()
    for (const item of items) if (item.kind === 'assistant') for (const block of item.blocks) if (block.kind === 'tool_use') ids.add(block.toolUseId)
    return ids
  }, [items])

  return (
    <div className="space-y-5">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="group flex animate-fade-in justify-end" data-role="user-message">
                <div className="max-w-[80%]">
                  {item.images && item.images.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                      {item.images.map((source, index) => (
                        <img key={index} src={source} alt={`Image jointe ${index + 1}`} className="max-h-40 max-w-60 rounded-md border border-gold/20 object-contain" />
                      ))}
                    </div>
                  )}
                  <div className="selectable rounded-lg rounded-br-sm border border-gold/20 bg-forest/70 px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap text-cream">{item.text}</div>
                  <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {conversationId && <RewindButton conversationId={conversationId} messageId={item.id} text={item.text} />}
                    <CopyButton text={item.text} />
                  </div>
                </div>
              </div>
            )
          case 'assistant':
            return <AssistantMessage key={item.id} item={item} results={results} />
          case 'tool_result':
            // Results are shown inside their tool card; orphan results (tool use not in view) are shown alone.
            if (knownToolUses.has(item.toolUseId)) return null
            return (
              <div key={item.id} className="rounded-md border border-line bg-sunken/60 px-3 py-2">
                <div className="text-[11px] text-ink-faint">Résultat d’outil</div>
                <pre className="selectable mt-1 max-h-48 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-ink-muted">{item.content}</pre>
              </div>
            )
          case 'system': {
            const tones = { info: 'border-info/25 bg-info/8 text-info', warning: 'border-warning/30 bg-warning/8 text-warning', error: 'border-danger/30 bg-danger-soft text-danger' }
            const icons = { info: <Info className="size-3.5" />, warning: <AlertTriangle className="size-3.5" />, error: <XCircle className="size-3.5" /> }
            return (
              <div key={item.id} className={classNames('selectable flex animate-fade-in items-start gap-2 rounded-md border px-3 py-2 text-[12.5px]', tones[item.tone])}>
                <span className="mt-0.5 shrink-0">{icons[item.tone]}</span>
                <span className="whitespace-pre-wrap">{item.text}</span>
              </div>
            )
          }
          case 'turn_summary':
            return (
              <div key={item.id} className="flex items-center gap-3 text-[11px] text-ink-faint">
                <span className="h-px flex-1 bg-line" />
                <span>{formatSeconds(item.durationMs)}</span>
                <span>·</span>
                <span>
                  {formatTokens(item.inputTokens)} entrée / {formatTokens(item.outputTokens)} sortie
                </span>
                {item.costUsd !== null && item.costUsd > 0 && (
                  <>
                    <span>·</span>
                    <span title="Estimation cumulée de Claude Code, pas une facture">~{formatUsd(item.costUsd)} (cumul session)</span>
                  </>
                )}
                <span className="h-px flex-1 bg-line" />
              </div>
            )
        }
      })}
    </div>
  )
}
