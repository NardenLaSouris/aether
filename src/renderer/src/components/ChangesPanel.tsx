/**
 * Following what Claude changes: the "Modifications" panel (changed files and their diff),
 * the "Fichier" panel (read-only viewer) and undoing a turn's file changes (rewind).
 */
import { Eye, FileCode2, FileDiff, GitBranch, RefreshCw, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { parseUnifiedDiff, type ChangedFile, type ChangesSummary, type FileContent } from '../../../shared/changes'
import type { TimelineItem } from '../../../shared/domain'
import { useLayoutStore } from '../layout/layoutStore'
import { api, errorMessage } from '../lib/api'
import { useComposerInsertStore } from '../mods/composerInsertStore'
import { useAppStore } from '../stores/appStore'
import { CopyButton } from './Markdown'
import { Button, classNames, confirmAction, Spinner } from './ui'

export const CHANGES_PANEL_ID = 'changes'
export const FILE_PANEL_ID = 'file'

// ---------------------------------------------------------------------------
// File viewer

interface FileViewerState {
  target: { conversationId: string; path: string; line?: number } | null
  open(conversationId: string, path: string, line?: number): void
}

export const useFileViewer = create<FileViewerState>((set) => ({
  target: null,
  open(conversationId, path, line) {
    set({ target: { conversationId, path, ...(line ? { line } : {}) } })
    const layout = useLayoutStore.getState()
    layout.open(FILE_PANEL_ID)
    layout.focus(FILE_PANEL_ID)
  }
}))

/** Opens a file in the viewer, for the active conversation. */
export function openFileInViewer(path: string, line?: number): void {
  const conversationId = useAppStore.getState().activeConversationId
  if (conversationId) useFileViewer.getState().open(conversationId, path, line)
}

export function FileViewerPanel() {
  const target = useFileViewer((state) => state.target)
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(() => {
    if (!target) return
    setLoading(true)
    setError(null)
    api
      .invoke('files:read', { conversationId: target.conversationId, path: target.path })
      .then(setFile)
      .catch((reason: unknown) => {
        setFile(null)
        setError(errorMessage(reason))
      })
      .finally(() => setLoading(false))
  }, [target])
  useEffect(load, [load])
  useEffect(() => {
    if (!file || !target?.line) return
    document.getElementById(`viewer-line-${target.line}`)?.scrollIntoView({ block: 'center' })
  }, [file, target?.line])

  if (!target) return <div className="p-4 text-[12.5px] text-ink-faint">Cliquez sur un fichier (modifications, outils de Claude) pour l’afficher ici.</div>
  const lines = file && !file.binary ? file.content.split('\n') : []
  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <FileCode2 className="size-3.5 text-gold" />
        <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={file?.path ?? target.path}>
          {file?.path ?? target.path}
        </span>
        <CopyButton text={file?.path ?? target.path} label="Copier le chemin" />
        <button type="button" aria-label="Recharger" onClick={load} className="rounded p-1 text-ink-faint hover:bg-white/5 hover:text-ink">
          <RefreshCw className={classNames('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && <div className="p-4 text-[12.5px] text-danger">{error}</div>}
        {file?.binary && <div className="p-4 text-[12.5px] text-ink-faint">Fichier binaire : pas d’aperçu.</div>}
        {file?.truncated && <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11.5px] text-warning">Fichier tronqué à 2 Mo.</div>}
        {lines.length > 0 && (
          <pre className="selectable min-w-max py-1 font-mono text-[12px] leading-[1.55]">
            {lines.map((line, index) => (
              <div key={index} id={`viewer-line-${index + 1}`} className={classNames('flex', target.line === index + 1 && 'bg-gold/10')}>
                <span className="w-12 shrink-0 pr-3 text-right text-ink-faint select-none">{index + 1}</span>
                <span className="pr-4 whitespace-pre text-ink-muted">{line || ' '}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Changes

const STATUS_LABELS: Record<ChangedFile['status'], { short: string; tone: string; label: string }> = {
  modified: { short: 'M', tone: 'text-gold', label: 'modifié' },
  added: { short: 'A', tone: 'text-sage', label: 'ajouté' },
  untracked: { short: 'N', tone: 'text-sage', label: 'nouveau' },
  deleted: { short: 'S', tone: 'text-danger', label: 'supprimé' },
  renamed: { short: 'R', tone: 'text-info', label: 'renommé' },
  conflicted: { short: '!', tone: 'text-danger', label: 'en conflit' }
}

/** Files Claude wrote or edited in the timeline (for a folder that is not a git repository). */
export function touchedFiles(items: TimelineItem[]): string[] {
  const paths = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block.kind !== 'tool_use' || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.toolName)) continue
      const input = (block.input ?? {}) as Record<string, unknown>
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
      if (path) paths.add(path)
    }
  }
  return [...paths]
}

function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  if (!diff.trim()) return <div className="p-3 text-[12px] text-ink-faint">Aucune différence avec le dernier commit.</div>
  return (
    <pre className="selectable min-w-max py-1 font-mono text-[11.5px] leading-[1.5]">
      {lines.map((line, index) =>
        line.kind === 'meta' ? null : (
          <div key={index} className={classNames('flex', line.kind === 'added' && 'bg-success/10', line.kind === 'removed' && 'bg-danger/10', line.kind === 'hunk' && 'bg-info/8 text-info')}>
            <span className="w-10 shrink-0 pr-2 text-right text-ink-faint select-none">{line.oldNumber ?? ''}</span>
            <span className="w-10 shrink-0 pr-2 text-right text-ink-faint select-none">{line.newNumber ?? ''}</span>
            <span className={classNames('w-4 shrink-0 select-none', line.kind === 'added' ? 'text-[#b9dcb9]' : line.kind === 'removed' ? 'text-[#e6b5aa]' : 'text-ink-faint')}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</span>
            <span className={classNames('pr-4 whitespace-pre', line.kind === 'added' ? 'text-[#b9dcb9]' : line.kind === 'removed' ? 'text-[#e6b5aa]' : line.kind === 'hunk' ? '' : 'text-ink-muted')}>{line.text || ' '}</span>
          </div>
        )
      )}
    </pre>
  )
}

export function ChangesPanel() {
  const conversationId = useAppStore((state) => state.activeConversationId)
  const runnerState = useAppStore((state) => (state.activeConversationId ? state.runtimes[state.activeConversationId]?.runnerState : undefined))
  const items = useAppStore((state) => (state.activeConversationId ? state.timelines[state.activeConversationId] : undefined))
  const [summary, setSummary] = useState<ChangesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const refresh = useCallback(() => {
    if (!conversationId) return
    setLoading(true)
    api
      .invoke('changes:list', { conversationId })
      .then((result) => {
        setSummary(result)
        setError(null)
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setLoading(false))
  }, [conversationId])

  // On opening, on switching conversation, and each time Claude finishes working.
  useEffect(refresh, [refresh])
  useEffect(() => {
    if (runnerState === 'ready' || runnerState === 'idle') refresh()
  }, [runnerState, refresh])
  useEffect(() => {
    setSelected(null)
    setDiff(null)
  }, [conversationId])

  useEffect(() => {
    if (!conversationId || !selected || !summary?.isRepository) return
    setDiffLoading(true)
    api
      .invoke('changes:file-diff', { conversationId, path: selected })
      .then(setDiff)
      .catch((reason: unknown) => setDiff(`Diff illisible : ${errorMessage(reason)}`))
      .finally(() => setDiffLoading(false))
  }, [conversationId, selected, summary])

  if (!conversationId) return <div className="p-4 text-[12.5px] text-ink-faint">Ouvrez une conversation pour voir ses modifications.</div>
  const files = summary?.files ?? []
  const totals = files.reduce((sum, file) => ({ insertions: sum.insertions + (file.insertions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }), { insertions: 0, deletions: 0 })
  const touched = summary && !summary.isRepository ? touchedFiles(items ?? []) : []
  const filePath = (path: string): string => (summary?.repositoryRoot ? `${summary.repositoryRoot}/${path}` : path)

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
        <FileDiff className="size-3.5 text-gold" />
        <span className="font-medium text-ink">Modifications</span>
        {summary?.branch && (
          <span className="flex min-w-0 items-center gap-1 truncate text-ink-faint">
            <GitBranch className="size-3" />
            {summary.branch}
          </span>
        )}
        {files.length > 0 && (
          <span className="text-ink-faint tabular-nums">
            {files.length} fichier{files.length > 1 ? 's' : ''} · <span className="text-[#b9dcb9]">+{totals.insertions}</span> <span className="text-[#e6b5aa]">−{totals.deletions}</span>
          </span>
        )}
        <button type="button" aria-label="Actualiser" onClick={refresh} className="ml-auto rounded p-1 text-ink-faint hover:bg-white/5 hover:text-ink">
          <RefreshCw className={classNames('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      {error && <div className="p-3 text-[12px] text-danger">{error}</div>}
      {summary && !summary.isRepository && (
        <div className="min-h-0 flex-1 overflow-auto p-3 text-[12.5px]">
          <p className="mb-2 text-ink-faint">Ce dossier n’est pas un dépôt git : pas de diff. Fichiers écrits ou modifiés par Claude dans cette conversation :</p>
          {touched.length === 0 && <p className="text-ink-faint">Aucun pour l’instant.</p>}
          {touched.map((path) => (
            <button key={path} type="button" onClick={() => openFileInViewer(path)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[12px] text-ink-muted hover:bg-white/4 hover:text-ink">
              <Eye className="size-3.5 shrink-0" /> <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      )}
      {summary?.isRepository && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className={classNames('shrink-0 overflow-y-auto border-b border-line py-1', selected ? 'max-h-[40%]' : 'flex-1')}>
            {files.length === 0 && <p className="px-3 py-3 text-[12.5px] text-ink-faint">Aucune modification non commitée.</p>}
            {files.map((file) => {
              const status = STATUS_LABELS[file.status]
              const slash = file.path.lastIndexOf('/')
              return (
                <div key={file.path} className={classNames('group flex items-center gap-2 px-3 py-1 text-[12px]', selected === file.path ? 'bg-accent-soft' : 'hover:bg-white/4')}>
                  <button type="button" onClick={() => setSelected(selected === file.path ? null : file.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={`${file.path} (${status.label})`}>
                    <span className={classNames('w-3 shrink-0 text-center font-mono font-bold', status.tone)}>{status.short}</span>
                    <span className="truncate text-ink">{file.path.slice(slash + 1)}</span>
                    {slash > 0 && <span className="truncate font-mono text-[11px] text-ink-faint">{file.path.slice(0, slash)}</span>}
                    <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
                      {file.insertions !== null && <span className="text-[#b9dcb9]">+{file.insertions}</span>} {file.deletions !== null && file.deletions > 0 && <span className="text-[#e6b5aa]">−{file.deletions}</span>}
                    </span>
                  </button>
                  {file.status !== 'deleted' && (
                    <button type="button" aria-label={`Voir ${file.path}`} onClick={() => openFileInViewer(filePath(file.path))} className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink">
                      <Eye className="size-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {selected && <div className="min-h-0 flex-1 overflow-auto">{diffLoading ? <div className="flex items-center gap-2 p-3 text-[12px] text-ink-faint"><Spinner className="size-3.5" /> Lecture du diff…</div> : <DiffView diff={diff ?? ''} />}</div>}
        </div>
      )}
      {!summary && !error && (
        <div className="flex items-center gap-2 p-3 text-[12px] text-ink-faint">
          <Spinner className="size-3.5" /> Lecture…
        </div>
      )}
    </div>
  )
}

/** Opens the "Modifications" panel. */
export function openChangesPanel(): void {
  const layout = useLayoutStore.getState()
  layout.open(CHANGES_PANEL_ID)
  layout.focus(CHANGES_PANEL_ID)
}

// ---------------------------------------------------------------------------
// Rewind

/** Restores the files to their state before a user message, after showing what will change. */
export async function rewindBefore(conversationId: string, messageId: string, messageText: string): Promise<void> {
  const { toast } = useAppStore.getState()
  try {
    const preview = await api.invoke('chat:rewind-files', { conversationId, userMessageId: messageId, dryRun: true })
    if (!preview.canRewind) {
      toast({ tone: 'warning', title: 'Retour arrière impossible', body: preview.error ?? 'Aucune sauvegarde des fichiers pour ce message (messages envoyés avant cette version d’Aether, ou fichiers modifiés hors de Claude).' })
      return
    }
    const files = preview.filesChanged ?? []
    if (files.length === 0) {
      toast({ tone: 'info', title: 'Rien à restaurer', body: 'Les fichiers sont déjà dans leur état d’avant ce message.' })
      return
    }
    const confirmed = await confirmAction({
      title: 'Annuler les modifications de fichiers depuis ce message ?',
      danger: true,
      confirmLabel: 'Restaurer les fichiers',
      message: (
        <div className="space-y-2">
          <p>
            Les {files.length} fichier{files.length > 1 ? 's' : ''} suivant{files.length > 1 ? 's' : ''} reviennent à leur état d’avant ce message ({preview.insertions ?? 0} ajout{(preview.insertions ?? 0) > 1 ? 's' : ''}, {preview.deletions ?? 0} suppression{(preview.deletions ?? 0) > 1 ? 's' : ''} de lignes). Vos propres modifications faites depuis sur ces fichiers seront aussi perdues.
          </p>
          <ul className="selectable max-h-40 overflow-y-auto rounded border border-line bg-sunken px-2 py-1 font-mono text-[11.5px]">
            {files.map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-ink-faint">La conversation n’est pas effacée : Aether prépare un message pour prévenir Claude.</p>
        </div>
      )
    })
    if (!confirmed) return
    const result = await api.invoke('chat:rewind-files', { conversationId, userMessageId: messageId, dryRun: false })
    if (!result.canRewind) {
      toast({ tone: 'error', title: 'Restauration échouée', body: result.error ?? 'Claude Code n’a pas pu restaurer les fichiers.' })
      return
    }
    toast({ tone: 'success', title: 'Fichiers restaurés', body: `${result.filesChanged?.length ?? files.length} fichier(s) revenu(s) à leur état d’avant ce message.` })
    const quoted = messageText.trim().split('\n')[0]?.slice(0, 120) ?? ''
    useComposerInsertStore.getState().insert(conversationId, `J’ai annulé tes modifications de fichiers depuis mon message « ${quoted} » : ces fichiers sont revenus à leur état d’avant (${files.join(', ')}). Tiens-en compte pour la suite.`, true)
  } catch (error) {
    toast({ tone: 'error', title: 'Retour arrière impossible', body: errorMessage(error) })
  }
}

export function RewindButton({ conversationId, messageId, text }: { conversationId: string; messageId: string; text: string }) {
  const busy = useAppStore((state) => {
    const runner = state.runtimes[conversationId]?.runnerState
    return runner === 'running' || runner === 'starting' || runner === 'interrupting'
  })
  const [working, setWorking] = useState(false)
  // Only messages sent from Aether have the identifier Claude Code's checkpoints use.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={working ? <Spinner className="size-3" /> : <RotateCcw className="size-3" />}
      disabled={busy || working}
      title={busy ? 'Attendez que Claude ait fini' : 'Remettre les fichiers dans leur état d’avant ce message'}
      onClick={() => {
        setWorking(true)
        void rewindBefore(conversationId, messageId, text).finally(() => setWorking(false))
      }}
    >
      Annuler les modifs depuis ici
    </Button>
  )
}
