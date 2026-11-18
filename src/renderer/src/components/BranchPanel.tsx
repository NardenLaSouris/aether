/**
 * The conversation's branch and its pull request: isolated conversations (own worktree and branch),
 * pushing, opening the PR, following its CI checks and asking Claude to fix them.
 */
import { CheckCircle2, CircleDashed, ExternalLink, GitBranch, GitPullRequest, LoaderCircle, RefreshCw, Upload, Wrench, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fixChecksPrompt, type BranchInfo, type PullRequestCheck, type PullRequestInfo } from '../../../shared/branch'
import type { Conversation } from '../../../shared/domain'
import { useLayoutStore } from '../layout/layoutStore'
import { api, errorMessage } from '../lib/api'
import { useComposerInsertStore } from '../mods/composerInsertStore'
import { useAppStore } from '../stores/appStore'
import { CopyButton } from './Markdown'
import { Badge, Button, classNames, confirmAction, Dialog, promptText, Spinner, Toggle } from './ui'

export const BRANCH_PANEL_ID = 'branch'
const POLL_MS = 45_000

export function openBranchPanel(): void {
  const layout = useLayoutStore.getState()
  layout.open(BRANCH_PANEL_ID)
  layout.focus(BRANCH_PANEL_ID)
}

/** Whether a conversation works in one of Aether's worktrees. */
export function isIsolatedConversation(conversation: Pick<Conversation, 'workingDirectory'>): boolean {
  return /[\\/]\.aether[\\/]worktrees[\\/][^\\/]+[\\/]?$/i.test(conversation.workingDirectory)
}

/** Asks for a name, then creates the isolated conversation. */
export async function startIsolatedConversation(from: Conversation): Promise<void> {
  const name = await promptText({ title: 'Nouvelle conversation isolée', label: 'Sujet (donne aussi le nom de la branche)', initialValue: '' })
  if (!name?.trim()) return
  await useAppStore.getState().createIsolatedConversation(from.id, name.trim())
}

export async function removeIsolatedWorktree(conversation: Conversation): Promise<void> {
  const confirmed = await confirmAction({
    title: 'Supprimer le worktree de cette conversation ?',
    danger: true,
    confirmLabel: 'Supprimer le worktree',
    message: (
      <span>
        Le dossier <code className="selectable font-mono text-[12px]">{conversation.workingDirectory}</code> est retiré et la conversation archivée. <strong>La branche et ses commits sont conservés</strong>. Git refuse si le dossier contient des modifications non commitées.
      </span>
    )
  })
  if (confirmed) await useAppStore.getState().removeConversationWorktree(conversation.id)
}

function CheckIcon({ state }: { state: PullRequestCheck['state'] }) {
  if (state === 'success') return <CheckCircle2 className="size-3.5 shrink-0 text-sage" />
  if (state === 'failure') return <XCircle className="size-3.5 shrink-0 text-danger" />
  if (state === 'pending') return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-gold" />
  return <CircleDashed className="size-3.5 shrink-0 text-ink-faint" />
}

function openExternal(url: string): void {
  void api.invoke('shell:open-external', { url }).catch((error: unknown) => useAppStore.getState().toast({ tone: 'error', title: 'Lien non ouvert', body: errorMessage(error) }))
}

function CreatePullRequestDialog({ conversation, info, onClose, onCreated }: { conversation: Conversation; info: BranchInfo; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState(conversation.title)
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [working, setWorking] = useState(false)
  const toast = useAppStore((state) => state.toast)
  const submit = async (): Promise<void> => {
    setWorking(true)
    try {
      const result = await api.invoke('branch:create-pr', { conversationId: conversation.id, title, body, draft })
      if (result.created) toast({ tone: 'success', title: 'Pull request ouverte', body: result.url })
      else toast({ tone: 'info', title: 'Branche poussée', body: 'GitHub s’ouvre dans le navigateur pour créer la PR (GitHub CLI absent ou non connecté).' })
      onCreated()
      onClose()
    } catch (error) {
      toast({ tone: 'error', title: 'PR non créée', body: errorMessage(error) })
    } finally {
      setWorking(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-xl"
      title={
        <span className="flex items-center gap-2">
          <GitPullRequest className="size-4 text-gold" /> Ouvrir une pull request
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={working} disabled={!title.trim()} onClick={() => void submit()}>
            {info.ghReady ? 'Pousser et ouvrir la PR' : 'Pousser et continuer sur GitHub'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-ink-muted">
          <span className="font-mono text-ink">{info.branch}</span> → <span className="font-mono text-ink">{info.defaultBranch ?? 'main'}</span> sur <span className="font-mono">{info.github}</span>. La branche est d’abord poussée (jamais en force).
        </p>
        <label className="block">
          <span className="text-[12px] text-ink-faint">Titre</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-line bg-sunken px-3 outline-none focus:border-gold/50" />
        </label>
        <label className="block">
          <span className="text-[12px] text-ink-faint">Description (Markdown)</span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={6} className="mt-1 w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 outline-none focus:border-gold/50" />
        </label>
        <Toggle checked={draft} onChange={setDraft} label="Brouillon (draft)" description="La PR est ouverte en brouillon, sans demander de revue." />
        {!info.ghReady && <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{info.ghProblem ?? 'GitHub CLI indisponible.'} Sans lui, Aether pousse la branche puis ouvre la page GitHub de création de la PR.</p>}
      </div>
    </Dialog>
  )
}

export function BranchPanel() {
  const conversation = useAppStore((state) => state.conversations.find((item) => item.id === state.activeConversationId) ?? null)
  const runnerState = useAppStore((state) => (state.activeConversationId ? state.runtimes[state.activeConversationId]?.runnerState : undefined))
  const toast = useAppStore((state) => state.toast)
  const [info, setInfo] = useState<BranchInfo | null>(null)
  const [pullRequest, setPullRequest] = useState<PullRequestInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [creating, setCreating] = useState(false)
  const conversationId = conversation?.id ?? null

  const refresh = useCallback(async () => {
    if (!conversationId) return
    setLoading(true)
    try {
      const next = await api.invoke('branch:info', { conversationId })
      setInfo(next)
      setError(null)
      setPullRequest(next.ghReady ? await api.invoke('branch:pull-request', { conversationId }) : null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    setInfo(null)
    setPullRequest(null)
    void refresh()
  }, [refresh])
  // After each of Claude's turns (it may have committed), and while checks are running.
  useEffect(() => {
    if (runnerState === 'ready' || runnerState === 'idle') void refresh()
  }, [runnerState, refresh])
  const checking = pullRequest?.state === 'OPEN' && pullRequest.checks.some((check) => check.state === 'pending')
  useEffect(() => {
    if (!checking) return undefined
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [checking, refresh])

  if (!conversation) return <div className="p-4 text-[12.5px] text-ink-faint">Ouvrez une conversation pour voir sa branche.</div>
  const push = async (): Promise<void> => {
    if (!info?.branch) return
    const confirmed = await confirmAction({ title: 'Pousser la branche ?', confirmLabel: 'Pousser', message: <span>Envoie <code className="font-mono">{info.branch}</code> vers origin{info.github ? ` (${info.github})` : ''}. Jamais en force.</span> })
    if (!confirmed) return
    setPushing(true)
    try {
      await api.invoke('branch:push', { conversationId: conversation.id })
      toast({ tone: 'success', title: 'Branche poussée', body: info.branch })
      await refresh()
    } catch (reason) {
      toast({ tone: 'error', title: 'Push refusé', body: errorMessage(reason) })
    } finally {
      setPushing(false)
    }
  }
  const failing = pullRequest?.checks.filter((check) => check.state === 'failure') ?? []
  const passed = pullRequest?.checks.filter((check) => check.state === 'success').length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-canvas text-[12.5px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <GitBranch className="size-3.5 text-gold" />
        <span className="font-medium text-ink">Branche et PR</span>
        <button type="button" aria-label="Actualiser" onClick={() => void refresh()} className="ml-auto rounded p-1 text-ink-faint hover:bg-white/5 hover:text-ink">
          <RefreshCw className={classNames('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      {error && <div className="p-3 text-danger">{error}</div>}
      {!info && !error && (
        <div className="flex items-center gap-2 p-3 text-ink-faint">
          <Spinner className="size-3.5" /> Lecture…
        </div>
      )}
      {info && !info.isRepository && <div className="p-3 text-ink-faint">Ce dossier n’est pas un dépôt git.</div>}
      {info?.isRepository && (
        <div className="space-y-3 p-3">
          <section className="space-y-1.5 rounded-md border border-line bg-panel/60 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="selectable font-mono text-ink">{info.branch ?? 'HEAD détaché'}</span>
              {info.isWorktree && <Badge tone="sage">isolée</Badge>}
              {info.upstream ? (
                <span className="text-ink-faint">
                  {info.ahead > 0 && <span className="text-gold">↑{info.ahead} </span>}
                  {info.behind > 0 && <span className="text-warning">↓{info.behind} </span>}
                  {info.ahead === 0 && info.behind === 0 && 'à jour avec origin'}
                </span>
              ) : (
                <span className="text-ink-faint">jamais poussée</span>
              )}
            </div>
            <div className="text-ink-faint">
              {info.uncommitted > 0 ? `${info.uncommitted} fichier(s) non commité(s)` : 'Rien à commiter'} · base {info.defaultBranch ?? '?'}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Button size="sm" variant="subtle" icon={<Upload className="size-3.5" />} loading={pushing} disabled={!info.branch || info.branch === info.defaultBranch} onClick={() => void push()}>
                Pousser
              </Button>
              {!pullRequest && info.github && (
                <Button size="sm" variant="primary" icon={<GitPullRequest className="size-3.5" />} disabled={!info.branch || info.branch === info.defaultBranch} onClick={() => setCreating(true)}>
                  Ouvrir une PR
                </Button>
              )}
              {!info.isWorktree && (
                <Button size="sm" variant="ghost" icon={<GitBranch className="size-3.5" />} onClick={() => void startIsolatedConversation(conversation)}>
                  Conversation isolée
                </Button>
              )}
            </div>
            {info.branch === info.defaultBranch && <p className="text-[11.5px] text-ink-faint">Vous êtes sur la branche principale : ouvrez une conversation isolée pour travailler sur une branche à part, puis en faire une PR.</p>}
          </section>

          {pullRequest && (
            <section className="space-y-2 rounded-md border border-line bg-panel/60 p-2.5">
              <div className="flex items-center gap-1.5">
                <GitPullRequest className={classNames('size-3.5', pullRequest.state === 'MERGED' ? 'text-info' : pullRequest.state === 'CLOSED' ? 'text-danger' : 'text-sage')} />
                <span className="font-medium text-ink">#{pullRequest.number}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">{pullRequest.title}</span>
                <Badge tone={pullRequest.state === 'OPEN' ? 'sage' : undefined}>{pullRequest.isDraft ? 'brouillon' : pullRequest.state === 'OPEN' ? 'ouverte' : pullRequest.state === 'MERGED' ? 'fusionnée' : 'fermée'}</Badge>
              </div>
              <div className="flex flex-wrap gap-x-3 text-[11.5px] text-ink-faint">
                {pullRequest.reviewDecision && <span>Revue : {pullRequest.reviewDecision === 'APPROVED' ? 'approuvée' : pullRequest.reviewDecision === 'CHANGES_REQUESTED' ? 'changements demandés' : 'en attente'}</span>}
                {pullRequest.mergeable === 'CONFLICTING' && <span className="text-danger">Conflits avec la base</span>}
                {pullRequest.checks.length > 0 && (
                  <span>
                    CI : {passed}/{pullRequest.checks.length} réussie(s){checking ? ' · en cours…' : ''}
                  </span>
                )}
              </div>
              {pullRequest.checks.length > 0 && (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                  {pullRequest.checks.map((check, index) => (
                    <li key={`${check.name}-${index}`} className="flex items-center gap-2">
                      <CheckIcon state={check.state} />
                      <span className="min-w-0 flex-1 truncate text-ink-muted">{check.name}</span>
                      {check.url?.startsWith('https://github.com/') && (
                        <button type="button" aria-label={`Ouvrir ${check.name}`} onClick={() => openExternal(check.url as string)} className="text-ink-faint hover:text-ink">
                          <ExternalLink className="size-3" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="subtle" icon={<ExternalLink className="size-3.5" />} onClick={() => openExternal(pullRequest.url)}>
                  Ouvrir sur GitHub
                </Button>
                <CopyButton text={pullRequest.url} label="Copier le lien" />
                {failing.length > 0 && (
                  <Button size="sm" variant="primary" icon={<Wrench className="size-3.5" />} onClick={() => useComposerInsertStore.getState().insert(conversation.id, fixChecksPrompt(pullRequest), true)}>
                    Faire corriger par Claude
                  </Button>
                )}
              </div>
              {failing.length > 0 && <p className="text-[11.5px] text-ink-faint">« Faire corriger » prépare le message dans la zone de saisie : vous l’envoyez.</p>}
            </section>
          )}
          {info.github && !info.ghReady && (
            <section className="rounded-md border border-warning/30 bg-warning/10 p-2.5 text-[12px] text-warning">
              <p>{info.ghProblem}</p>
              <p className="mt-1 text-ink-muted">Sans GitHub CLI, Aether pousse la branche et ouvre la page GitHub de création de la PR, mais ne peut pas suivre la CI.</p>
              <div className="mt-1.5 flex gap-1.5">
                <CopyButton text="winget install GitHub.cli" label="Copier la commande d’installation" />
                <CopyButton text="gh auth login" label="Copier gh auth login" />
              </div>
            </section>
          )}
          {!info.github && <p className="text-ink-faint">Le dépôt distant n’est pas sur GitHub : pas de PR depuis Aether.</p>}
          {info.isWorktree && isIsolatedConversation(conversation) && (
            <button type="button" onClick={() => void removeIsolatedWorktree(conversation)} className="text-[11.5px] text-ink-faint underline-offset-2 hover:text-danger hover:underline">
              Supprimer le worktree (la branche reste)…
            </button>
          )}
        </div>
      )}
      {creating && info && <CreatePullRequestDialog conversation={conversation} info={info} onClose={() => setCreating(false)} onCreated={() => void refresh()} />}
    </div>
  )
}

/** The branch in the conversation header; opens the panel. */
export function BranchBadge({ conversation }: { conversation: Conversation }) {
  const [branch, setBranch] = useState<string | null>(null)
  const runnerState = useAppStore((state) => state.runtimes[conversation.id]?.runnerState)
  useEffect(() => {
    let alive = true
    void api
      .invoke('branch:info', { conversationId: conversation.id })
      .then((info) => alive && setBranch(info.branch))
      .catch(() => alive && setBranch(null))
    return () => {
      alive = false
    }
  }, [conversation.id, runnerState])
  if (!branch) return null
  return (
    <button type="button" onClick={openBranchPanel} title="Branche et pull request" className={classNames('flex max-w-56 items-center gap-1 truncate rounded-full border px-2 py-0.5 font-mono text-[11px]', isIsolatedConversation(conversation) ? 'border-sage/40 text-sage' : 'border-line text-ink-muted')}>
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{branch}</span>
    </button>
  )
}
