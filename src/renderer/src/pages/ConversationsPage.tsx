import { Archive, ArchiveRestore, ArrowDown, FileDiff, FolderX, GitBranch, History, MessageSquarePlus, MessagesSquare, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react'
import { CodexLinkButton } from '../pilot/PilotPanel'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Conversation } from '../../../shared/domain'
import { Timeline } from '../components/Timeline'
import { Composer, QuotaBanner } from '../components/workspace'
import { Badge, Button, classNames, confirmAction, EmptyState, IconButton, promptText, Spinner, useContextMenu, type MenuItem } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatRelative } from '../lib/format'
import { useAppStore } from '../stores/appStore'
import { EmbeddedModPanels } from '../mods/EmbeddedModPanels'
import { openChangesPanel } from '../components/ChangesPanel'
import { BranchBadge, isIsolatedConversation, removeIsolatedWorktree, startIsolatedConversation } from '../components/BranchPanel'

function useConversationMenu(): (conversation: Conversation) => MenuItem[] {
  const rename = useAppStore((state) => state.renameConversation)
  const archive = useAppStore((state) => state.archiveConversation)
  const remove = useAppStore((state) => state.deleteConversation)
  const toast = useAppStore((state) => state.toast)
  return (conversation) => [
    {
      label: 'Renommer',
      icon: <Pencil className="size-3.5" />,
      onSelect: async () => {
        const title = await promptText({ title: 'Renommer la conversation', label: 'Titre', initialValue: conversation.title })
        if (title) await rename(conversation.id, title).catch((error: unknown) => toast({ tone: 'error', title: 'Renommage impossible', body: errorMessage(error) }))
      }
    },
    {
      label: 'Nouvelle conversation isolée (branche à part)',
      icon: <GitBranch className="size-3.5" />,
      onSelect: () => void startIsolatedConversation(conversation)
    },
    ...(isIsolatedConversation(conversation) && !conversation.archived
      ? [{ label: 'Supprimer le worktree (garde la branche)', icon: <FolderX className="size-3.5" />, onSelect: () => void removeIsolatedWorktree(conversation) }]
      : []),
    conversation.archived
      ? { label: 'Restaurer', icon: <ArchiveRestore className="size-3.5" />, onSelect: () => void archive(conversation.id, false) }
      : { label: 'Archiver', icon: <Archive className="size-3.5" />, onSelect: () => void archive(conversation.id, true) },
    {
      label: 'Supprimer',
      icon: <Trash2 className="size-3.5" />,
      danger: true,
      onSelect: async () => {
        const confirmed = await confirmAction({
          title: 'Supprimer la conversation ?',
          message: (
            <>
              « {conversation.title} » sera retirée d’Aether.
              {conversation.claudeSessionId ? ' Le transcript d’origine reste intact dans le stockage de Claude Code et pourra être retrouvé dans « Sessions Claude Code ».' : ''}
            </>
          ),
          confirmLabel: 'Supprimer',
          danger: true
        })
        if (confirmed) await remove(conversation.id)
      }
    }
  ]
}

function ConversationList() {
  const conversations = useAppStore((state) => state.conversations)
  const activeId = useAppStore((state) => state.activeConversationId)
  const open = useAppStore((state) => state.openConversation)
  const create = useAppStore((state) => state.createConversation)
  const showArchived = useAppStore((state) => state.showArchived)
  const setShowArchived = useAppStore((state) => state.setShowArchived)
  const projects = useAppStore((state) => state.projects)
  const runtimes = useAppStore((state) => state.runtimes)
  const pending = useAppStore((state) => state.pendingPermissions)
  const openMenu = useContextMenu((state) => state.open)
  const menuFor = useConversationMenu()
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Conversation[] | null>(null)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResults(null)
      return
    }
    const timer = window.setTimeout(() => {
      void api.invoke('conversations:search', { query: trimmed }).then(setSearchResults)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query])

  const list = searchResults ?? conversations
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel/60">
      <div className="space-y-2.5 border-b border-line p-3">
        <div className="flex gap-1.5">
          <Button variant="primary" className="flex-1" icon={<MessageSquarePlus className="size-4" />} onClick={() => void create(null)}>
            Nouvelle conversation
          </Button>
          <IconButton
            label="Nouvelle conversation isolée : sa propre branche et son propre dossier (worktree), depuis le dépôt de la conversation ouverte"
            onClick={() => {
              const current = conversations.find((item) => item.id === activeId)
              if (current) void startIsolatedConversation(current)
              else useAppStore.getState().toast({ tone: 'info', title: 'Conversation isolée', body: 'Ouvrez d’abord une conversation du dépôt à isoler.' })
            }}
          >
            <GitBranch className="size-4" />
          </IconButton>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 focus-within:border-gold/40">
          <Search className="size-3.5 text-ink-faint" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher" aria-label="Rechercher dans les conversations" className="h-8 w-full bg-transparent text-[13px] outline-none placeholder:text-ink-faint" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {list.length === 0 && <div className="px-3 py-8 text-center text-xs text-ink-faint">{query ? 'Aucun résultat.' : 'Aucune conversation.'}</div>}
        {list.map((conversation) => {
          const runtime = runtimes[conversation.id]
          const busy = runtime?.runnerState === 'running' || runtime?.runnerState === 'starting'
          const waiting = pending.some((request) => request.conversationId === conversation.id)
          return (
            <button
              key={conversation.id}
              type="button"
              onClick={() => void open(conversation.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                openMenu({ x: event.clientX, y: event.clientY }, menuFor(conversation))
              }}
              className={classNames('group mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors', activeId === conversation.id ? 'bg-forest/70 shadow-[inset_2px_0_0_#C4A96A]' : 'hover:bg-white/4')}
            >
              <span className="flex items-center gap-1.5">
                {busy && <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-gold" />}
                {waiting && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Autorisation en attente" />}
                <span className="truncate text-[13px] text-ink">{conversation.title}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Actions"
                  onClick={(event) => {
                    event.stopPropagation()
                    openMenu({ x: event.clientX, y: event.clientY }, menuFor(conversation))
                  }}
                  className="ml-auto rounded p-0.5 text-ink-faint opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-ink"
                >
                  <MoreHorizontal className="size-3.5" />
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                {conversation.projectId && <span className="truncate text-sage">{projectNames.get(conversation.projectId)}</span>}
                {conversation.origin === 'imported' && <History className="size-3" aria-label="Session reprise" />}
                {conversation.archived && <Archive className="size-3" />}
                <span className="ml-auto shrink-0">{formatRelative(conversation.updatedAt)}</span>
              </span>
            </button>
          )
        })}
      </div>
      <EmbeddedModPanels embed="conversation-list" />
      <label className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-ink-faint">
        <input type="checkbox" checked={showArchived} onChange={(event) => void setShowArchived(event.target.checked)} className="accent-[#C4A96A]" />
        Afficher les archives
      </label>
    </aside>
  )
}

function ConversationView({ conversation }: { conversation: Conversation }) {
  const items = useAppStore((state) => state.timelines[conversation.id])
  const runtime = useAppStore((state) => state.runtimes[conversation.id])
  const openMenu = useContextMenu((state) => state.open)
  const menuFor = useConversationMenu()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  const timeline = useMemo(() => items ?? [], [items])

  useEffect(() => {
    setStickToBottom(true)
  }, [conversation.id])

  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom) element.scrollTop = element.scrollHeight
  }, [timeline, stickToBottom])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
        <h1 className="truncate font-display text-[14px] font-semibold">{conversation.title}</h1>
        {conversation.origin === 'imported' && <Badge tone="sage">Session reprise</Badge>}
        {runtime?.activeModel && <Badge>{runtime.activeModel}</Badge>}
        <BranchBadge conversation={conversation} />
        <div className="flex-1" />
        {conversation.claudeSessionId && <span className="selectable font-mono text-[11px] text-ink-faint" title="Identifiant de session Claude Code">{conversation.claudeSessionId}</span>}
        <Button size="sm" variant="ghost" icon={<FileDiff className="size-3.5" />} onClick={openChangesPanel} title="Fichiers modifiés et leur diff">
          Modifications
        </Button>
        <CodexLinkButton conversationId={conversation.id} />
        <IconButton label="Actions" onClick={(event) => openMenu({ x: event.clientX - 160, y: event.clientY + 12 }, menuFor(conversation))}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      </header>
      <QuotaBanner />
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget
            setStickToBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80)
          }}
          className="h-full overflow-y-auto px-6 py-6"
        >
          <div className="mx-auto max-w-4xl">
            {runtime?.loadingHistory && (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-faint">
                <Spinner /> Chargement de l’historique Claude Code…
              </div>
            )}
            {runtime?.historyError && <div className="mb-4 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning">{runtime.historyError}</div>}
            {!runtime?.loadingHistory && timeline.length === 0 && (
              <EmptyState
                icon={<MessagesSquare className="size-5" />}
                title="Commencez la conversation"
                description={
                  <>
                    Claude Code travaillera dans <span className="font-mono text-ink">{conversation.workingDirectory}</span>. Les actions sensibles vous seront soumises pour approbation.
                  </>
                }
              />
            )}
            <Timeline items={timeline} conversationId={conversation.id} />
          </div>
        </div>
        {!stickToBottom && (
          <button type="button" onClick={() => setStickToBottom(true)} className="absolute right-8 bottom-4 flex items-center gap-1 rounded-full border border-line-strong bg-raised px-3 py-1.5 text-xs text-ink-muted shadow-pop hover:text-ink">
            <ArrowDown className="size-3.5" /> Bas de la conversation
          </button>
        )}
      </div>
      <Composer conversation={conversation} />
    </div>
  )
}

export function ConversationsPage() {
  const conversations = useAppStore((state) => state.conversations)
  const activeId = useAppStore((state) => state.activeConversationId)
  const create = useAppStore((state) => state.createConversation)
  const active = conversations.find((conversation) => conversation.id === activeId)
  return (
    <div className="flex h-full min-h-0">
      <ConversationList />
      {active ? (
        <ConversationView key={active.id} conversation={active} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<MessagesSquare className="size-5" />}
            title="Aucune conversation sélectionnée"
            description="Choisissez une conversation à gauche, créez-en une nouvelle ou reprenez une session existante de Claude Code."
            action={
              <Button variant="primary" icon={<MessageSquarePlus className="size-4" />} onClick={() => void create(null)}>
                Nouvelle conversation
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}
