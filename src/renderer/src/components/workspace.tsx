/**
 * Conversation workspace widgets: composer, model and permission-mode pickers,
 * permission approval dialog, quota banner with countdown.
 */
import { ArrowUp, Brain, Check, ChevronDown, ImagePlus, ListPlus, Pencil, X, Zap, Clock, Cpu, FolderOpen, Hourglass, Puzzle, ShieldAlert, ShieldCheck, ShieldQuestion, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { SELECTABLE_PERMISSION_MODES, type Conversation, type PermissionModeOption, type PermissionRequest } from '../../../shared/domain'
import { LIMIT_LABELS, evaluateBlock, formatDuration } from '../../../shared/quota'
import type { ModPane } from '../../../shared/engineProtocol'
import { deriveTodos, describeToolCall, describeToolConsequences } from '../../../shared/timeline'
import { shortPath } from '../lib/format'
import { useModsStore } from '../mods/modsStore'
import { EmbeddedModPanels } from '../mods/EmbeddedModPanels'
import { PlanDialog, QuestionDialog } from './ClaudeDialogs'
import { PinnedTodos } from './TodoList'
import { useMessageQueue, type QueuedMessage } from '../stores/messageQueue'
import { AttachmentStrip, effortLabel, MentionList, useFileMentions, useImageAttachments } from './ComposerExtras'
import { EFFORT_LEVELS, type EffortLevel } from '../../../shared/domain'
import { useComposerInsertStore } from '../mods/composerInsertStore'
import { useAppStore } from '../stores/appStore'
import { Badge, Button, classNames, confirmAction, Dialog } from './ui'

/** What the Claude Code mods report for this conversation: their status line, and the panes Aether cannot draw. */
function ModStatusBar({ modStatus, modPanes }: { modStatus: Record<string, string>; modPanes: ModPane[] }) {
  const entries = Object.entries(modStatus).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0 && modPanes.length === 0) return null
  return (
    <div aria-label="Mods Claude Code" className="mx-auto mb-2 flex max-w-4xl flex-wrap items-center gap-1.5 text-[11.5px]">
      <Puzzle className="size-3.5 text-ink-faint" aria-hidden="true" />
      {entries.map(([plugin, text]) => (
        <span key={plugin} title={`Mod ${plugin}`} className="selectable max-w-80 truncate rounded-full border border-line bg-panel px-2 py-0.5 text-ink-muted">
          {text}
        </span>
      ))}
      {modPanes.map((pane) => (
        <span key={pane.id} title={`Le mod ${pane.plugin} affiche un panneau. Aether ne peut pas le dessiner : ouvrez cette session dans Claude Code pour le voir.`} className="rounded-full border border-dashed border-line px-2 py-0.5 text-ink-faint">
          Panneau « {pane.title} » : non affichable ici
        </span>
      ))}
    </div>
  )
}

/** While typing `/…`, lists the matching commands of the enabled Aether mods. */
function ModCommandHints({ draft, onPick }: { draft: string; onPick: (name: string) => void }) {
  const mods = useModsStore((state) => state.catalog?.mods)
  const match = /^\/([a-z0-9-]*)$/.exec(draft.trim())
  if (!match || !mods) return null
  const typed = match[1] ?? ''
  const commands = mods.filter((mod) => mod.enabled).flatMap((mod) => mod.manifest.commands.filter((command) => command.name.startsWith(typed)).map((command) => ({ mod, command })))
  if (commands.length === 0) return null
  return (
    <div role="listbox" aria-label="Commandes des mods Aether" className="mx-auto mb-2 flex max-w-4xl flex-wrap gap-1.5">
      {commands.map(({ mod, command }) => (
        <button key={`${mod.manifest.id}:${command.name}`} type="button" role="option" aria-selected={command.name === typed} onClick={() => onPick(command.name)} title={`Mod Aether « ${mod.manifest.name} » : ouvre un panneau, rien n’est envoyé à Claude`} className="flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] hover:border-line-strong">
          <span className="font-mono text-gold">/{command.name}</span>
          <span className="text-ink-faint">{command.description}</span>
        </button>
      ))}
    </div>
  )
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

function Popover({ anchor, open, onClose, children, align = 'left' }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; children: React.ReactNode; align?: 'left' | 'right' }) {
  if (!open || !anchor) return null
  const rect = anchor.getBoundingClientRect()
  const style = { bottom: window.innerHeight - rect.top + 6, ...(align === 'left' ? { left: rect.left } : { right: window.innerWidth - rect.right }) }
  return createPortal(
    <div className="fixed inset-0 z-[95]" onMouseDown={onClose}>
      <div style={style} className="fixed max-h-[60vh] w-80 animate-rise overflow-y-auto rounded-lg border border-line-strong bg-[#212523] p-1 shadow-pop" onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  )
}

/** Thinking effort of the conversation (Claude Code's /effort). */
export function EffortPicker({ conversation }: { conversation: Conversation }) {
  const own = useAppStore((state) => state.preferences?.conversationEfforts?.[conversation.id] ?? null)
  const fallback = useAppStore((state) => state.preferences?.defaultEffort ?? null)
  const setEffort = useAppStore((state) => state.setConversationEffort)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const current = own ?? fallback
  const choose = (effort: EffortLevel | null): void => {
    setOpen(false)
    void setEffort(conversation.id, effort)
  }
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(!open)} title="Effort de réflexion de Claude pour cette conversation" className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-ink-muted hover:border-sage/50">
        <Brain className="size-3.5" />
        {effortLabel(current)}
      </button>
      <Popover anchor={anchorRef.current} open={open} onClose={() => setOpen(false)}>
        <div className="w-56 p-1">
          <div className="px-2 py-1 text-[11px] text-ink-faint">Effort de réflexion</div>
          {[null, ...EFFORT_LEVELS].map((effort) => (
            <button key={effort ?? 'auto'} type="button" onClick={() => choose(effort)} className={classNames('flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-white/5', (own ?? null) === effort ? 'text-gold' : 'text-ink')}>
              <span>{effort === null ? `Par défaut (${effortLabel(fallback)})` : effortLabel(effort)}</span>
            </button>
          ))}
          <div className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-ink-faint">Plus d’effort : réponses plus réfléchies, plus lentes et plus coûteuses en tokens.</div>
        </div>
      </Popover>
    </>
  )
}

export function ModelPicker({ conversation, activeModel }: { conversation: Conversation; activeModel: string | null }) {
  const models = useAppStore((state) => state.models)
  const modelsError = useAppStore((state) => state.modelsError)
  const defaultModel = useAppStore((state) => state.preferences?.defaultModel ?? null)
  const setModel = useAppStore((state) => state.setConversationModel)
  const refreshModels = useAppStore((state) => state.refreshModels)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const selected = conversation.model
  const selectedInfo = models.find((model) => model.value === selected)
  const unavailable = selected !== null && models.length > 0 && !selectedInfo
  const label = selectedInfo?.displayName ?? selected ?? (defaultModel ? `Par défaut (${models.find((model) => model.value === defaultModel)?.displayName ?? defaultModel})` : 'Modèle par défaut de Claude Code')
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => {
          setOpen(!open)
          if (models.length === 0) void refreshModels()
        }}
        className={classNames('flex h-7 max-w-64 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors hover:border-sage/50', unavailable ? 'border-warning/50 text-warning' : 'border-line text-ink-muted')}
        title={activeModel ? `Modèle actif : ${activeModel}` : undefined}
      >
        <Cpu className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      <Popover anchor={anchorRef.current} open={open} onClose={() => setOpen(false)}>
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] tracking-wide text-ink-faint uppercase">Modèles disponibles (Claude Code)</div>
        {models.length === 0 && <div className="px-2.5 py-2 text-xs text-ink-muted">{modelsError ? `Liste indisponible : ${modelsError}` : 'Chargement de la liste depuis Claude Code…'}</div>}
        <button type="button" onClick={() => (void setModel(conversation.id, null), setOpen(false))} className="flex w-full items-start gap-2 rounded px-2.5 py-2 text-left hover:bg-white/5">
          <span className="mt-0.5 size-3.5">{selected === null && <Check className="size-3.5 text-gold" />}</span>
          <span>
            <span className="block text-[13px]">Par défaut</span>
            <span className="block text-[11px] text-ink-faint">Préférence d’Aether, sinon choix de Claude Code</span>
          </span>
        </button>
        {models.map((model) => (
          <button key={model.value} type="button" onClick={() => (void setModel(conversation.id, model.value), setOpen(false))} className="flex w-full items-start gap-2 rounded px-2.5 py-2 text-left hover:bg-white/5">
            <span className="mt-0.5 size-3.5">{selected === model.value && <Check className="size-3.5 text-gold" />}</span>
            <span className="min-w-0">
              <span className="block text-[13px]">{model.displayName}</span>
              <span className="block text-[11px] text-ink-faint">{model.description}</span>
              {model.resolvedModel && model.resolvedModel !== model.value && <span className="block font-mono text-[10.5px] text-ink-faint">{model.resolvedModel}</span>}
            </span>
          </button>
        ))}
        {unavailable && <div className="m-1 rounded border border-warning/30 bg-warning/8 px-2.5 py-2 text-[11px] text-warning">Le modèle « {selected} » n’est plus proposé par Claude Code. Choisissez-en un autre.</div>}
      </Popover>
    </>
  )
}

const MODE_LABELS: Record<PermissionModeOption, { label: string; description: string }> = {
  default: { label: 'Demander', description: 'Chaque action sensible demande votre accord.' },
  acceptEdits: { label: 'Accepter les modifications', description: 'Les éditions de fichiers sont acceptées ; le reste demande votre accord.' },
  plan: { label: 'Planification', description: 'Claude analyse et propose un plan sans rien exécuter.' },
  bypassPermissions: { label: 'Tout autoriser', description: 'Aucune demande : comme claude --dangerously-skip-permissions.' }
}

/** Asks before switching to "tout autoriser"; every other mode is applied directly. */
export async function confirmBypassMode(): Promise<boolean> {
  return confirmAction({
    title: 'Tout autoriser ?',
    message: 'Claude exécutera toutes les commandes et modifiera les fichiers sans rien vous demander, comme avec « claude --dangerously-skip-permissions ». Vos règles « deny » de Claude Code et les politiques de votre organisation restent appliquées. À réserver à un projet suivi par git.',
    confirmLabel: 'Tout autoriser',
    danger: true
  })
}

export function PermissionModePicker({ conversation }: { conversation: Conversation }) {
  const setMode = useAppStore((state) => state.setConversationPermissionMode)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(!open)} className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-ink-muted hover:border-sage/50">
        {conversation.permissionMode === 'bypassPermissions' ? <ShieldAlert className="size-3.5 text-warning" /> : conversation.permissionMode === 'default' ? <ShieldQuestion className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
        {MODE_LABELS[conversation.permissionMode].label}
        <ChevronDown className="size-3" />
      </button>
      <Popover anchor={anchorRef.current} open={open} onClose={() => setOpen(false)}>
        {SELECTABLE_PERMISSION_MODES.map((mode) => (
          <button key={mode} type="button" onClick={() => {
              setOpen(false)
              if (mode === 'bypassPermissions' && conversation.permissionMode !== mode) void confirmBypassMode().then((confirmed) => {
                  if (confirmed) void setMode(conversation.id, mode)
                })
              else void setMode(conversation.id, mode)
            }} className="flex w-full items-start gap-2 rounded px-2.5 py-2 text-left hover:bg-white/5">
            <span className="mt-0.5 size-3.5">{conversation.permissionMode === mode && <Check className="size-3.5 text-gold" />}</span>
            <span>
              <span className="block text-[13px]">{MODE_LABELS[mode].label}</span>
              <span className="block text-[11px] text-ink-faint">{MODE_LABELS[mode].description}</span>
            </span>
          </button>
        ))}
        <div className="px-2.5 py-2 text-[11px] text-ink-faint">Vos règles de permission Claude Code s’appliquent dans tous les modes.</div>
      </Popover>
    </>
  )
}

const RUNNER_LABELS: Record<string, string> = { idle: 'Prêt', starting: 'Démarrage de Claude Code…', ready: 'Prêt', running: 'Claude travaille…', interrupting: 'Interruption…', closed: 'Session en veille', error: 'Erreur' }

const EMPTY_QUEUE: QueuedMessage[] = []

/** Messages waiting for Claude's next step, editable until they are handed over. */
function QueuedMessages({ conversationId, items, stopping, busy, onEdit, onSendNow }: { conversationId: string; items: QueuedMessage[]; stopping: boolean; busy: boolean; onEdit: (id: string) => void; onSendNow: () => void }) {
  if (items.length === 0) return null
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-faint">
        <ListPlus className="size-3 text-gold" />
        {stopping ? 'Arrêt de Claude… le message part juste après.' : busy ? `En file : Claude ${items.length > 1 ? 'les lira' : 'le lira'} à sa prochaine étape.` : 'Envoi…'}
        {busy && !stopping && (
          <button type="button" onClick={onSendNow} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-gold hover:bg-white/5" title="Arrête Claude et envoie la file tout de suite">
            <Zap className="size-3" /> Interrompre et envoyer
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="group flex items-start gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[12.5px]">
            <span className="selectable min-w-0 flex-1 whitespace-pre-wrap text-ink-muted">
              {item.text.length > 400 ? `${item.text.slice(0, 400)}…` : item.text}
              {item.images.length > 0 && <span className="ml-1.5 text-[11px] text-ink-faint">+{item.images.length} image(s)</span>}
            </span>
            <button type="button" aria-label="Modifier ce message" onClick={() => onEdit(item.id)} className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-white/5 hover:text-ink">
              <Pencil className="size-3" />
            </button>
            <button type="button" aria-label="Retirer ce message" onClick={() => useMessageQueue.getState().remove(conversationId, item.id)} className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-white/5 hover:text-danger">
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Composer({ conversation }: { conversation: Conversation }) {
  const runtime = useAppStore((state) => state.runtimes[conversation.id])
  const sendMessage = useAppStore((state) => state.sendMessage)
  const interrupt = useAppStore((state) => state.interrupt)
  const sendWithEnter = useAppStore((state) => state.preferences?.sendWithEnter ?? true)
  const quota = useAppStore((state) => state.quota)
  const installation = useAppStore((state) => state.installation)
  const projects = useAppStore((state) => state.projects)
  const now = useNow(1000)
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const runnerState = runtime?.runnerState ?? 'idle'
  const busy = runnerState === 'running' || runnerState === 'starting' || runnerState === 'interrupting'
  const blocked = evaluateBlock(quota.block, now).blocked
  const project = projects.find((candidate) => candidate.id === conversation.projectId)
  const timelineItems = useAppStore((state) => state.timelines[conversation.id])
  const todos = useMemo(() => deriveTodos(timelineItems ?? []), [timelineItems])
  const images = useImageAttachments()
  const mentions = useFileMentions(conversation.id, textareaRef, draft, setDraft)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`
  }, [draft])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [conversation.id])

  // Text a mod prepared (composer.insert): it lands in the draft, the user reads and sends it.
  const pendingInsert = useComposerInsertStore((state) => (state.pending?.conversationId === conversation.id ? state.pending : null))
  useEffect(() => {
    if (!pendingInsert) return
    setDraft((previous) => (pendingInsert.replace || !previous.trim() ? pendingInsert.text : `${previous.replace(/\s+$/, '')}\n${pendingInsert.text}`))
    setHistoryIndex(null)
    useComposerInsertStore.getState().take(pendingInsert.nonce)
    textareaRef.current?.focus()
  }, [pendingInsert])

  const queued = useMessageQueue((state) => state.queues[conversation.id] ?? EMPTY_QUEUE)
  const stopping = useMessageQueue((state) => state.interrupting[conversation.id] === true)

  const clearComposer = (typed: string): void => {
    if (typed) setHistory((previous) => [...previous.filter((entry) => entry !== typed), typed].slice(-50))
    setHistoryIndex(null)
    setDraft('')
    images.clear()
    mentions.close()
  }

  /** While Claude works: the message waits in the queue, or (interrupt) Claude stops and it goes right after. */
  const queueDraft = (interruptFirst: boolean): void => {
    const typed = draft.trim()
    const attached = images.attachments
    if (!typed && attached.length === 0 && !(interruptFirst && queued.length > 0)) return
    if (typed || attached.length > 0) useMessageQueue.getState().enqueue(conversation.id, { text: typed || 'Regarde cette image.', images: attached }, interruptFirst)
    clearComposer(typed)
    if (interruptFirst) {
      useMessageQueue.getState().setInterrupting(conversation.id, true)
      void interrupt(conversation.id)
    }
  }

  const submit = async (): Promise<void> => {
    const typed = draft.trim()
    const attached = images.attachments
    if (!typed && attached.length === 0) return
    // An image alone still needs a few words for Claude.
    const text = typed || 'Regarde cette image.'
    // A command of an Aether mod (e.g. /arbo) opens its panel and is not sent to Claude.
    if (useModsStore.getState().runCommand(text)) {
      setHistory((previous) => [...previous.filter((entry) => entry !== text), text].slice(-50))
      setHistoryIndex(null)
      setDraft('')
      return
    }
    if (blocked) return
    if (busy) {
      queueDraft(false)
      return
    }
    const sent = await sendMessage(conversation.id, text, attached)
    if (sent) clearComposer(typed)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The @file suggestions take the arrows, Enter, Tab and Escape while they are open.
    if (mentions.onKeyDown(event.key)) {
      event.preventDefault()
      return
    }
    // Alt+Entrée while Claude works: stop it and send this message right after.
    if (event.key === 'Enter' && event.altKey && busy) {
      event.preventDefault()
      queueDraft(true)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && (sendWithEnter || event.ctrlKey)) {
      event.preventDefault()
      void submit()
      return
    }
    if (event.key === 'Escape' && busy) {
      event.preventDefault()
      void interrupt(conversation.id)
      return
    }
    // Prompt history navigation (only when the caret is at the very start / end).
    if (event.key === 'ArrowUp' && history.length > 0 && event.currentTarget.selectionStart === 0) {
      event.preventDefault()
      const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      setDraft(history[nextIndex] ?? '')
    } else if (event.key === 'ArrowDown' && historyIndex !== null && event.currentTarget.selectionEnd === event.currentTarget.value.length) {
      event.preventDefault()
      const nextIndex = historyIndex + 1
      if (nextIndex >= history.length) {
        setHistoryIndex(null)
        setDraft('')
      } else {
        setHistoryIndex(nextIndex)
        setDraft(history[nextIndex] ?? '')
      }
    }
  }

  const disabledReason = !installation?.found ? 'Claude Code introuvable — voir Paramètres.' : blocked ? 'Envois suspendus : limite d’usage atteinte.' : null

  return (
    <div className="border-t border-line bg-canvas/60 px-6 pt-3 pb-4">
      <ModStatusBar modStatus={runtime?.modStatus ?? {}} modPanes={runtime?.modPanes ?? []} />
      <PinnedTodos todos={todos ?? []} />
      <EmbeddedModPanels embed="composer-top" className="mx-auto mb-2 max-w-4xl overflow-hidden rounded-md border border-line" />
      <ModCommandHints draft={draft} onPick={(name) => setDraft(`/${name}`)} />
      {mentions.open && <MentionList results={mentions.results} index={mentions.index} onChoose={mentions.choose} />}
      <div onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()} onDrop={images.onDrop} className={classNames('mx-auto max-w-4xl rounded-lg border bg-panel shadow-panel transition-colors', blocked ? 'border-warning/40' : 'border-line-strong')}>
        <QueuedMessages
          conversationId={conversation.id}
          items={queued}
          stopping={stopping}
          busy={busy}
          onEdit={(id) => {
            const item = useMessageQueue.getState().take(conversation.id, id)
            if (!item) return
            setDraft((previous) => (previous.trim() ? `${item.text}\n${previous}` : item.text))
            textareaRef.current?.focus()
          }}
          onSendNow={() => queueDraft(true)}
        />
        <AttachmentStrip attachments={images.attachments} onRemove={images.remove} />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            mentions.refresh(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }}
          onClick={(event) => mentions.refresh(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
          onBlur={() => window.setTimeout(mentions.close, 120)}
          onPaste={images.onPaste}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={
            disabledReason ??
            (busy
              ? `Claude travaille : ${sendWithEnter ? 'Entrée' : 'Ctrl+Entrée'} met le message en file (lu à sa prochaine étape), Alt+Entrée l’interrompt et l’envoie`
              : sendWithEnter
                ? 'Écrivez à Claude… @ pour un fichier, collez une image (Entrée pour envoyer, Maj+Entrée pour une ligne)'
                : 'Écrivez à Claude… @ pour un fichier, collez une image (Ctrl+Entrée pour envoyer)')
          }
          disabled={Boolean(disabledReason)}
          aria-label="Message"
          className="selectable block max-h-[280px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          <ModelPicker conversation={conversation} activeModel={runtime?.activeModel ?? null} />
          <PermissionModePicker conversation={conversation} />
          <EffortPicker conversation={conversation} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length) images.onDrop({ preventDefault: () => undefined, dataTransfer: { files } } as unknown as Parameters<typeof images.onDrop>[0])
            }}
          />
          <button type="button" aria-label="Joindre une image" title="Joindre une image (ou collez-la, ou glissez-la)" onClick={() => fileInputRef.current?.click()} className="flex size-7 items-center justify-center rounded-md border border-line text-ink-muted hover:border-sage/50 hover:text-ink">
            <ImagePlus className="size-3.5" />
          </button>
          <span className="flex h-7 max-w-72 items-center gap-1.5 truncate rounded-md px-2 text-[12px] text-ink-faint" title={conversation.workingDirectory}>
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="truncate">{project ? project.name : shortPath(conversation.workingDirectory, 40)}</span>
          </span>
          <div className="flex-1" />
          <span className={classNames('text-[11.5px]', runnerState === 'error' ? 'text-danger' : busy ? 'text-gold' : 'text-ink-faint')}>{RUNNER_LABELS[runnerState]}</span>
          {busy && (
            <Button variant="danger" size="sm" icon={<Square className="size-3" />} onClick={() => void interrupt(conversation.id)} disabled={runnerState === 'interrupting'}>
              Arrêter
            </Button>
          )}
          {busy && (draft.trim() || images.attachments.length > 0) && (
            <Button variant="subtle" size="sm" icon={<Zap className="size-3" />} onClick={() => queueDraft(true)} title="Arrête Claude et envoie ce message tout de suite (Alt+Entrée)">
              Interrompre et envoyer
            </Button>
          )}
          <button
            type="button"
            aria-label={busy ? 'Mettre en file' : 'Envoyer'}
            title={busy ? 'Mettre en file : Claude le lira à sa prochaine étape' : 'Envoyer'}
            onClick={() => void submit()}
            disabled={(!draft.trim() && images.attachments.length === 0) || Boolean(disabledReason)}
            className="flex size-8 items-center justify-center rounded-md border border-gold/50 bg-forest text-gold transition-colors hover:bg-[#124a37] disabled:cursor-not-allowed disabled:opacity-35"
          >
            {busy ? <ListPlus className="size-4" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}

export function QuotaBanner() {
  const quota = useAppStore((state) => state.quota)
  const navigate = useAppStore((state) => state.navigate)
  const now = useNow(1000)
  const block = quota.block
  if (!block) return null
  const evaluation = evaluateBlock(block, now)
  if (!evaluation.blocked) return null
  return (
    <div className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2.5 text-[12.5px] text-warning">
      <Hourglass className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{LIMIT_LABELS[block.limitKind]} atteinte.</span>{' '}
        {evaluation.millisecondsRemaining !== null ? (
          <>
            Reprise des envois dans <span className="font-mono font-semibold">{formatDuration(evaluation.millisecondsRemaining)}</span> ({new Date(block.resetsAt ?? 0).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}). Vos conversations restent consultables.
          </>
        ) : (
          <>Heure de réinitialisation non communiquée par Claude Code. {quota.nextAutomaticCheckAt ? `Prochaine vérification ${new Date(quota.nextAutomaticCheckAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : ''}</>
        )}
      </div>
      <Button size="sm" variant="ghost" icon={<Clock className="size-3.5" />} onClick={() => navigate('usage')}>
        Détails
      </Button>
    </div>
  )
}

function permissionSummary(request: PermissionRequest): string {
  return describeToolCall(request.toolName, request.input)
}

export function PermissionDialog() {
  const pending = useAppStore((state) => state.pendingPermissions)
  const conversations = useAppStore((state) => state.conversations)
  const decide = useAppStore((state) => state.decidePermission)
  const openConversation = useAppStore((state) => state.openConversation)
  const [denyReason, setDenyReason] = useState('')
  const request = pending[0]
  useEffect(() => setDenyReason(''), [request?.requestId])
  const conversation = useMemo(() => conversations.find((candidate) => candidate.id === request?.conversationId), [conversations, request?.conversationId])
  if (!request) return null
  // Claude's questions and plans have their own dialogs, like in Claude Code.
  if (request.toolName === 'AskUserQuestion') return <QuestionDialog request={request} waiting={pending.length - 1} />
  if (request.toolName === 'ExitPlanMode') return <PlanDialog request={request} waiting={pending.length - 1} />
  const summary = permissionSummary(request)
  return (
    <Dialog
      open
      dismissible={false}
      onClose={() => undefined}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <ShieldQuestion className="size-4 text-gold" />
          Autorisation requise
          {pending.length > 1 && <Badge tone="gold">+{pending.length - 1} en attente</Badge>}
        </span>
      }
      footer={
        <>
          <input value={denyReason} onChange={(event) => setDenyReason(event.target.value)} placeholder="Motif du refus (optionnel, transmis à Claude)" className="mr-auto w-72 rounded-md border border-line bg-sunken px-2.5 text-[12.5px] outline-none focus:border-gold/50" />
          <Button variant="danger" onClick={() => void decide(request.requestId, false, denyReason || undefined)}>
            Refuser
          </Button>
          <Button variant="primary" autoFocus onClick={() => void decide(request.requestId, true)}>
            Autoriser
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        {conversation && (
          <button type="button" className="text-xs text-ink-faint hover:text-ink" onClick={() => void openConversation(conversation.id)}>
            Conversation : <span className="text-ink-muted">{conversation.title}</span>
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="gold">{request.displayName ?? request.toolName}</Badge>
          {request.title && <span className="font-medium">{request.title}</span>}
        </div>
        {request.description && <p className="text-ink-muted">{request.description}</p>}
        <div>
          <div className="mb-1 text-[11px] tracking-wide text-ink-faint uppercase">Action</div>
          <pre className="selectable max-h-40 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-[12px] whitespace-pre-wrap text-cream">{summary}</pre>
        </div>
        <div>
          <div className="mb-1 text-[11px] tracking-wide text-ink-faint uppercase">Conséquences possibles</div>
          <p className="text-ink-muted">{describeToolConsequences(request.toolName)}</p>
          {request.decisionReason && <p className="mt-1 text-xs text-ink-faint">Motif de la demande (Claude Code) : {request.decisionReason}</p>}
          {request.blockedPath && <p className="mt-1 text-xs text-warning">Chemin hors des dossiers autorisés : {request.blockedPath}</p>}
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-ink-faint">Paramètres complets</summary>
          <pre className="selectable mt-1 max-h-60 overflow-auto rounded-md bg-black/25 p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-ink-muted">{JSON.stringify(request.input, null, 2)}</pre>
        </details>
      </div>
    </Dialog>
  )
}
