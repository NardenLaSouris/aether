/**
 * Codex pilot UI: the "Lier Codex / Détacher" button of a conversation, and the Pilote panel
 * (start form, live status, GPT's questions, the journal of tasks, commits and checks).
 */
import { AlertTriangle, Bot, CheckCircle2, CircleDot, Compass, GitBranch, GitCommit, Link2, Pause, Play, Send, ShieldAlert, Square, Terminal, Unlink, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { allowRuleForCheck, allowRuleProblem, branchNameProblem, isPilotActive, isProtectedBranch, type PilotBranchChoice, type PilotBranchInfo, type PilotConfig, type PilotRound, type PilotSnapshot, type PilotStatus } from '../../../shared/pilot'
import { Badge, Button, classNames, Dialog, Spinner, Toggle } from '../components/ui'
import { useLayoutStore } from '../layout/layoutStore'
import { useAppStore } from '../stores/appStore'
import { usePilotStore } from './pilotStore'

export const PILOT_PANEL_ID = 'pilot'

const STATUS_LABELS: Record<PilotStatus, string> = {
  idle: 'Prêt',
  thinking: 'GPT réfléchit',
  working: 'Claude travaille',
  checking: 'Vérifications',
  committing: 'Commit et push',
  waiting_quota: 'Attente du quota Claude',
  paused: 'En pause',
  done: 'Terminé'
}

function statusTone(status: PilotStatus): 'neutral' | 'gold' | 'sage' | 'warning' | 'info' {
  if (status === 'paused' || status === 'waiting_quota') return 'warning'
  if (status === 'done') return 'sage'
  if (isPilotActive(status)) return 'gold'
  return 'neutral'
}

function useSnapshot(conversationId: string | null): PilotSnapshot | null {
  const snapshot = usePilotStore((state) => (conversationId ? state.snapshots[conversationId] : undefined))
  const fetch = usePilotStore((state) => state.fetch)
  useEffect(() => {
    if (conversationId && !snapshot) void fetch(conversationId)
  }, [conversationId, snapshot, fetch])
  return snapshot ?? null
}

// ---------------------------------------------------------------------------
// Header button
// ---------------------------------------------------------------------------

export function CodexLinkButton({ conversationId }: { conversationId: string }) {
  const snapshot = useSnapshot(conversationId)
  const busy = usePilotStore((state) => state.busy[conversationId] ?? false)
  const link = usePilotStore((state) => state.link)
  const unlink = usePilotStore((state) => state.unlink)
  const openPanel = useLayoutStore((state) => state.open)
  const [confirming, setConfirming] = useState(false)
  if (!snapshot?.linked) {
    return (
      <Button size="sm" icon={<Link2 className="size-3.5" />} loading={busy} onClick={() => void link(conversationId).then((linked) => linked && openPanel(PILOT_PANEL_ID))} title="Relie cette conversation à Codex (votre compte ChatGPT) : GPT pilote, Claude exécute">
        Lier Codex
      </Button>
    )
  }
  const running = isPilotActive(snapshot.status) || snapshot.status === 'paused'
  return (
    <>
      <button type="button" onClick={() => openPanel(PILOT_PANEL_ID)} className="flex h-7 items-center gap-1.5 rounded-md border border-gold/40 bg-accent-soft px-2.5 text-[12px] text-gold" title="Ouvrir le panneau Pilote">
        <Bot className="size-3.5" />
        Codex lié · {STATUS_LABELS[snapshot.status]}
        {isPilotActive(snapshot.status) && <span className="size-1.5 animate-pulse-soft rounded-full bg-gold" />}
      </button>
      <Button size="sm" variant="ghost" icon={<Unlink className="size-3.5" />} loading={busy} onClick={() => (running ? setConfirming(true) : void unlink(conversationId))} aria-label="Détacher Codex">
        Détacher
      </Button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Détacher Codex ?"
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Annuler</Button>
            <Button variant="danger" onClick={() => (setConfirming(false), void unlink(conversationId))}>
              Arrêter et détacher
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">Le pilote est en cours : il sera arrêté (Claude interrompu s’il travaille). Les commits déjà faits restent sur la branche ; le journal est conservé.</p>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function PilotPanel() {
  const conversationId = useAppStore((state) => state.activeConversationId)
  const conversation = useAppStore((state) => state.conversations.find((candidate) => candidate.id === state.activeConversationId) ?? null)
  const snapshot = useSnapshot(conversationId)
  if (!conversationId || !conversation) {
    return <PanelMessage icon={<Compass className="size-5" />} title="Aucune conversation ouverte" text="Ouvrez une conversation puis liez-la à Codex pour que GPT pilote Claude." />
  }
  if (!snapshot?.linked) return <NotLinked conversationId={conversationId} />
  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-[13px] text-ink">
      <PilotHeader snapshot={snapshot} title={conversation.title} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {snapshot.question && <QuestionBox snapshot={snapshot} />}
        {snapshot.status === 'idle' || snapshot.status === 'done' ? <StartForm snapshot={snapshot} workingDirectory={conversation.workingDirectory} /> : <RunningSummary snapshot={snapshot} />}
        <Journal snapshot={snapshot} />
      </div>
    </div>
  )
}

/** Section block in Aether's card style: raised surface, hairline border, small caps title. */
function Section({ title, icon, children, className, actions }: { title?: string; icon?: React.ReactNode; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={classNames('animate-rise rounded-lg border border-line bg-panel shadow-panel', className)}>
      {title && (
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          {icon && <span className="text-gold [&>svg]:size-3.5">{icon}</span>}
          <h3 className="font-display text-[11px] font-semibold tracking-[0.08em] text-ink-muted uppercase">{title}</h3>
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-3 py-2.5">{children}</div>
    </section>
  )
}

function PanelMessage({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas bg-[radial-gradient(ellipse_at_top,rgba(15,61,46,0.55),transparent_65%)] px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-gold/30 bg-accent-soft text-gold shadow-pop">{icon}</div>
      <div className="font-display text-[15px] font-semibold text-ink">{title}</div>
      <div className="max-w-sm text-[12.5px] leading-relaxed text-ink-muted">{text}</div>
      {action}
    </div>
  )
}

function NotLinked({ conversationId }: { conversationId: string }) {
  const codex = usePilotStore((state) => state.codex)
  const checking = usePilotStore((state) => state.checkingCodex)
  const refresh = usePilotStore((state) => state.refreshCodex)
  const link = usePilotStore((state) => state.link)
  const busy = usePilotStore((state) => state.busy[conversationId] ?? false)
  useEffect(() => {
    if (!codex) void refresh()
  }, [codex, refresh])
  const detail = checking ? 'Recherche de Codex…' : !codex ? '' : !codex.found ? 'Codex CLI introuvable. Installez-le avec « npm i -g @openai/codex » (ou installez l’application Codex), puis « codex login ».' : !codex.loggedIn ? `Codex ${codex.version ?? ''} trouvé mais non connecté : lancez « codex login » et choisissez « Sign in with ChatGPT ».` : `Codex ${codex.version ?? ''} prêt (${codex.loginDetail ?? 'connecté'}).`
  return (
    <PanelMessage
      icon={<Compass className="size-5" />}
      title="Codex n’est pas lié à cette conversation"
      text={`GPT découpe l’objectif en tâches, Claude les exécute ici, Aether vérifie. ${detail}`}
      action={
        <div className="mt-1 flex gap-2">
          <Button size="sm" variant="primary" icon={<Link2 className="size-3.5" />} loading={busy} disabled={codex !== null && (!codex.found || !codex.loggedIn)} onClick={() => void link(conversationId)}>
            Lier Codex
          </Button>
          <Button size="sm" onClick={() => void refresh()} loading={checking}>
            Revérifier
          </Button>
        </div>
      }
    />
  )
}

/** The loop's stages, lit up as the pilot moves through them. */
const STAGES: { status: PilotStatus[]; label: string }[] = [
  { status: ['thinking'], label: 'GPT' },
  { status: ['working', 'waiting_quota'], label: 'Claude' },
  { status: ['checking'], label: 'Vérif.' },
  { status: ['committing'], label: 'Commit' }
]

function StageRail({ status }: { status: PilotStatus }) {
  const current = STAGES.findIndex((stage) => stage.status.includes(status))
  if (current < 0) return null
  return (
    <ol className="mt-2 flex items-center gap-1" aria-label="Étape du pilote">
      {STAGES.map((stage, index) => (
        <li key={stage.label} className="flex flex-1 items-center gap-1">
          <span
            className={classNames(
              'flex-1 rounded-full border px-2 py-0.5 text-center text-[10.5px] font-medium tracking-wide transition-colors',
              index === current ? 'border-gold/50 bg-accent-soft text-gold' : index < current ? 'border-sage/30 text-sage' : 'border-line text-ink-faint'
            )}
          >
            {stage.label}
          </span>
          {index < STAGES.length - 1 && <span className={classNames('h-px w-2 shrink-0', index < current ? 'bg-sage/50' : 'bg-line-strong')} />}
        </li>
      ))}
    </ol>
  )
}

function PilotHeader({ snapshot, title }: { snapshot: PilotSnapshot; title: string }) {
  const pause = usePilotStore((state) => state.pause)
  const resume = usePilotStore((state) => state.resume)
  const stop = usePilotStore((state) => state.stop)
  const busy = usePilotStore((state) => state.busy[snapshot.conversationId] ?? false)
  const active = isPilotActive(snapshot.status)
  const paused = snapshot.status === 'paused'
  return (
    <div className="shrink-0 border-b border-line bg-gradient-to-b from-forest/70 to-forest-night/40 px-3 pt-2.5 pb-2">
      <div className="flex items-center gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-gold/35 bg-accent-soft text-gold">
          <Compass className={classNames('size-3.5', active && 'animate-pulse-soft')} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-[13px] font-semibold text-cream">Pilote Codex</span>
            <Badge tone={statusTone(snapshot.status)}>
              {active && snapshot.status !== 'waiting_quota' && <span className="inline-block size-1.5 animate-pulse-soft rounded-full bg-gold" />}
              {STATUS_LABELS[snapshot.status]}
            </Badge>
          </div>
          <div className="truncate text-[11.5px] text-ink-faint" title={title}>
            {title}
          </div>
        </div>
        {active && <Button size="sm" icon={<Pause className="size-3" />} onClick={() => void pause(snapshot.conversationId)} aria-label="Mettre le pilote en pause" title="Pause" />}
        {paused && !snapshot.question && (
          <Button size="sm" variant="primary" icon={<Play className="size-3" />} onClick={() => void resume(snapshot.conversationId)}>
            Reprendre
          </Button>
        )}
        {(active || paused) && <Button size="sm" variant="danger" icon={<Square className="size-3" />} loading={busy} onClick={() => void stop(snapshot.conversationId)} aria-label="Arrêter le pilote" title="Arrêter" />}
      </div>
      <StageRail status={snapshot.status} />
      {snapshot.statusMessage && snapshot.status !== 'done' && <div className={classNames('selectable mt-2 text-[12px] leading-snug', paused || snapshot.status === 'waiting_quota' ? 'text-warning' : 'text-ink-muted')}>{snapshot.statusMessage}</div>}
    </div>
  )
}

function QuestionBox({ snapshot }: { snapshot: PilotSnapshot }) {
  const answer = usePilotStore((state) => state.answer)
  const [text, setText] = useState('')
  return (
    <Section title="Question de GPT" icon={<Bot />} className="border-gold/40 bg-accent-soft">
      <div className="selectable whitespace-pre-wrap text-[13px] text-ink">{snapshot.question}</div>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="Votre réponse à GPT" placeholder="Votre réponse…" className={classNames(FIELD, 'mt-2')} />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="primary" icon={<Send className="size-3" />} disabled={!text.trim()} onClick={() => void answer(snapshot.conversationId, text).then((sent) => sent && setText(''))}>
          Répondre et reprendre
        </Button>
      </div>
    </Section>
  )
}

const FIELD = 'selectable block w-full resize-y rounded-md border border-line-strong bg-sunken px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-gold/60'

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1.5 block text-[12px] text-ink-muted">{children}</span>
}

function StartForm({ snapshot, workingDirectory }: { snapshot: PilotSnapshot; workingDirectory: string }) {
  const start = usePilotStore((state) => state.start)
  const busy = usePilotStore((state) => state.busy[snapshot.conversationId] ?? false)
  const previous = snapshot.config
  const [objective, setObjective] = useState(previous?.objective ?? '')
  const [doneCriteria, setDoneCriteria] = useState(previous?.doneCriteria ?? '')
  const [checks, setChecks] = useState((previous?.checks ?? []).join('\n'))
  const [allowedTools, setAllowedTools] = useState((previous?.allowedTools ?? []).join('\n'))
  const [allowFileEdits, setAllowFileEdits] = useState(previous?.allowFileEdits ?? false)
  const [allowAllCommands, setAllowAllCommands] = useState(previous?.allowAllCommands ?? false)
  const [autoCommit, setAutoCommit] = useState(previous?.autoCommit ?? false)
  const [codexReadsProject, setCodexReadsProject] = useState(previous?.codexReadsProject ?? true)
  const [branch, setBranch] = useState<PilotBranchChoice>(previous?.branch ?? (previous?.autoCommit ? { mode: 'new' } : { mode: 'current' }))
  const [allowProtectedBranch, setAllowProtectedBranch] = useState(previous?.allowProtectedBranch ?? false)
  const [branchInfo, setBranchInfo] = useState<PilotBranchInfo | null>(null)
  const loadBranches = usePilotStore((state) => state.branches)
  useEffect(() => {
    let alive = true
    void loadBranches(snapshot.conversationId).then((info) => {
      if (alive) setBranchInfo(info)
    })
    return () => {
      alive = false
    }
  }, [loadBranches, snapshot.conversationId])
  const isRepository = branchInfo?.isRepository !== false
  const targetBranch = branch.mode === 'current' ? (branchInfo?.current ?? null) : branch.mode === 'new' ? null : branch.name.trim()
  const branchProblem = !isRepository ? null : branch.mode === 'create' || branch.mode === 'existing' ? branchNameProblem(branch.name) : branch.mode === 'current' && branchInfo && !branchInfo.current ? 'HEAD est détaché : choisissez une branche.' : null
  const targetProtected = autoCommit && isRepository && targetBranch !== null && isProtectedBranch(targetBranch, branchInfo?.defaultBranch ?? null)
  const repositoryProblem = !isRepository && autoCommit ? 'Les commits automatiques demandent un dépôt git.' : null
  const ruleProblems = useMemo(() => linesOf(allowedTools).map(allowRuleProblem).filter((problem): problem is string => problem !== null), [allowedTools])
  const suggestRules = (): void => {
    const suggested = linesOf(checks)
      .map(allowRuleForCheck)
      .filter((rule): rule is string => rule !== null)
    setAllowedTools([...new Set([...linesOf(allowedTools), ...suggested])].join('\n'))
  }
  const config: PilotConfig = { objective, doneCriteria, checks: linesOf(checks), allowedTools: linesOf(allowedTools), allowFileEdits: allowFileEdits || allowAllCommands, allowAllCommands, autoCommit, codexReadsProject, branch: isRepository ? branch : { mode: 'current' }, allowProtectedBranch: targetProtected && allowProtectedBranch }
  return (
    <div className="space-y-3">
      {snapshot.status === 'done' && snapshot.statusMessage && (
        <Section title="Bilan de GPT" icon={<CheckCircle2 />} className="border-sage/40">
          <div className="selectable whitespace-pre-wrap text-ink">{snapshot.statusMessage}</div>
        </Section>
      )}
      <Section title="Mission" icon={<Compass />}>
        <div className="space-y-3">
          <label className="block">
            <FieldLabel>Objectif</FieldLabel>
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} aria-label="Objectif du pilote" placeholder="Ex. : ajouter l’export PDF des conversations, avec ses tests" className={FIELD} />
          </label>
          <label className="block">
            <FieldLabel>Critères de fin</FieldLabel>
            <textarea value={doneCriteria} onChange={(event) => setDoneCriteria(event.target.value)} rows={2} aria-label="Critères de fin" placeholder="Ex. : tests verts, lint propre, export utilisable depuis le menu" className={FIELD} />
          </label>
          <label className="block">
            <FieldLabel>Vérifications lancées par Aether après chaque tâche (une par ligne)</FieldLabel>
            <textarea value={checks} onChange={(event) => setChecks(event.target.value)} rows={2} aria-label="Vérifications" placeholder={'pnpm test\npnpm lint'} className={classNames(FIELD, 'font-mono text-[12px]')} />
          </label>
        </div>
      </Section>

      <Section title="Autonomie de Claude" icon={<Terminal />}>
        <div className="divide-y divide-line">
          <Toggle checked={allowAllCommands} onChange={setAllowAllCommands} label="Tout autoriser, sans aucune demande" description="Comme « claude --dangerously-skip-permissions » : Claude lance toutes les commandes, modifie les fichiers et utilise ses outils sans vous attendre." />
          {!allowAllCommands && <Toggle checked={allowFileEdits} onChange={setAllowFileEdits} label="Modifier les fichiers sans demander" description={`Mode « Accepter les modifications » de Claude Code, limité à ${workingDirectory}.`} />}
        </div>
        {allowAllCommands ? (
          <div className="mt-2 flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11.5px] leading-snug text-warning">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>Pendant cette session de pilotage seulement. Claude pourra tout faire dans {workingDirectory}, y compris des suppressions. Vos règles « deny » de Claude Code et les politiques de votre organisation restent appliquées. Préférez un dépôt git propre avec les commits automatiques, pour pouvoir revenir en arrière.</span>
          </div>
        ) : (
          <div className="mt-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-ink-muted">Commandes autorisées (règles Claude Code)</span>
              <button type="button" onClick={suggestRules} className="text-[11.5px] text-gold hover:underline disabled:opacity-40 disabled:hover:no-underline" disabled={linesOf(checks).length === 0}>
                Autoriser les vérifications
              </button>
            </div>
            <textarea value={allowedTools} onChange={(event) => setAllowedTools(event.target.value)} rows={2} aria-label="Règles d’autorisation" placeholder="Bash(pnpm test:*)" className={classNames(FIELD, 'mt-1.5 font-mono text-[12px]')} />
            {ruleProblems.map((problem) => (
              <div key={problem} className="mt-1 text-[11.5px] text-danger">
                {problem}
              </div>
            ))}
            <div className="mt-1.5 text-[11.5px] text-ink-faint">Le reste (suppressions, push, réseau, commandes inconnues) vous est demandé comme d’habitude.</div>
          </div>
        )}
      </Section>

      <Section title="Branche et git" icon={<GitBranch />}>
        <BranchPicker info={branchInfo} choice={branch} onChange={setBranch} autoCommit={autoCommit} />
        {branchProblem && <div className="mt-1.5 text-[11.5px] text-danger">{branchProblem}</div>}
        {repositoryProblem && <div className="mt-1.5 text-[11.5px] text-danger">{repositoryProblem}</div>}
        {targetProtected && (
          <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-2.5">
            <Toggle checked={allowProtectedBranch} onChange={setAllowProtectedBranch} label={`Commiter et pousser directement sur « ${targetBranch ?? ''} »`} description="C’est une branche principale : chaque tâche validée y sera commitée et poussée (jamais en force)." />
          </div>
        )}
        <div className="mt-1 divide-y divide-line">
          <Toggle checked={codexReadsProject} onChange={setCodexReadsProject} label="GPT peut lire le projet (lecture seule)" description="Pour vérifier les rapports de Claude sur le code réel. Il ne peut rien modifier." />
          <Toggle checked={autoCommit} onChange={setAutoCommit} label="Commits et push automatiques" description="Quand Claude déclare la tâche terminée, que les vérifications passent et que GPT l’accepte. Branche aether/pilote-… dédiée, jamais forcée ni sur la branche principale, bloqué si un secret est détecté. Demande un dossier sans modifications en attente." />
        </div>
      </Section>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Play className="size-3.5" />} loading={busy} disabled={objective.trim().length < 5 || (!allowAllCommands && ruleProblems.length > 0) || branchProblem !== null || repositoryProblem !== null || (targetProtected && !allowProtectedBranch)} onClick={() => void start(snapshot.conversationId, allowAllCommands ? { ...config, allowedTools: config.allowedTools.filter((rule) => allowRuleProblem(rule) === null) } : config)}>
          {snapshot.status === 'done' ? 'Relancer le pilote' : 'Lancer le pilote'}
        </Button>
      </div>
    </div>
  )
}

const NEW_BRANCH = '__aether_new__'
const CREATE_BRANCH = '__aether_create__'
const CURRENT_BRANCH = '__aether_current__'

function BranchPicker({ info, choice, onChange, autoCommit }: { info: PilotBranchInfo | null; choice: PilotBranchChoice; onChange: (choice: PilotBranchChoice) => void; autoCommit: boolean }) {
  if (!info) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-ink-faint">
        <Spinner className="size-3.5" /> Lecture des branches…
      </div>
    )
  }
  if (!info.isRepository) return <div className="text-[12px] text-ink-faint">Ce dossier n’est pas un dépôt git : le pilote travaille dans le dossier tel quel.</div>
  const value = choice.mode === 'new' ? NEW_BRANCH : choice.mode === 'create' ? CREATE_BRANCH : choice.mode === 'current' ? CURRENT_BRANCH : choice.name
  const others = info.branches.filter((name) => name !== info.current)
  return (
    <div className="space-y-2">
      <label className="block">
        <FieldLabel>Branche de travail</FieldLabel>
        <select
          value={value}
          aria-label="Branche de travail du pilote"
          onChange={(event) => {
            const next = event.target.value
            if (next === NEW_BRANCH) onChange({ mode: 'new' })
            else if (next === CREATE_BRANCH) onChange({ mode: 'create', name: '' })
            else if (next === CURRENT_BRANCH) onChange({ mode: 'current' })
            else onChange({ mode: 'existing', name: next })
          }}
          className={classNames(FIELD, 'resize-none font-mono text-[12px]')}
        >
          <option value={CURRENT_BRANCH}>Branche actuelle{info.current ? ` : ${info.current}` : ' (HEAD détaché)'}</option>
          <option value={NEW_BRANCH}>Nouvelle branche du pilote (aether/pilote-…)</option>
          <option value={CREATE_BRANCH}>Nouvelle branche nommée…</option>
          {others.length > 0 && (
            <optgroup label="Branches existantes">
              {others.map((name) => (
                <option key={name} value={name}>
                  {info.worktrees[name] ? `${name} — worktree ${info.worktrees[name]}` : name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {choice.mode === 'create' && <input value={choice.name} onChange={(event) => onChange({ mode: 'create', name: event.target.value })} aria-label="Nom de la nouvelle branche" placeholder="feature/export-pdf" className={classNames(FIELD, 'font-mono text-[12px]')} />}
      <div className="text-[11.5px] text-ink-faint">
        {choice.mode === 'current' ? 'Le pilote reste sur la branche actuelle.' : choice.mode === 'existing' && info.worktrees[choice.name] ? `« ${choice.name} » est déjà ouverte dans le worktree ${info.worktrees[choice.name]} : le pilote travaille dans ce dossier (vérifications, commits, lecture par GPT), sans changer de branche ici.` : choice.mode === 'existing' ? `Aether bascule sur « ${choice.name} » au lancement (git switch).` : `Créée à partir de « ${info.current ?? 'HEAD'} » au lancement.`}
        {!info.clean && (autoCommit ? ' Le dossier a des modifications non commitées : commitez-les avant de lancer avec commits automatiques.' : ' Le dossier a des modifications non commitées : git les emporte sur la branche choisie, ou refuse de changer de branche.')}
      </div>
    </div>
  )
}

function RunningSummary({ snapshot }: { snapshot: PilotSnapshot }) {
  const { usage, config } = snapshot
  return (
    <Section title="En cours" icon={<Compass />}>
      <div className="space-y-2.5">
        {config && (
          <div className="selectable line-clamp-3 border-l-2 border-gold/60 pl-2.5 text-[12.5px] text-ink" title={config.objective}>
            {config.objective}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {config?.allowAllCommands ? (
            <Badge tone="warning">
              <Terminal className="size-3" /> Toutes les commandes
            </Badge>
          ) : config?.allowFileEdits ? (
            <Badge tone="sage">Modifications acceptées</Badge>
          ) : (
            <Badge>Permissions habituelles</Badge>
          )}
          {config?.autoCommit && (
            <Badge tone="gold">
              <GitCommit className="size-3" /> Commits auto
            </Badge>
          )}
        </div>
        {snapshot.branch && (
          <div className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            <GitBranch className="size-3.5 text-gold" />
            <span className="selectable font-mono text-ink">{snapshot.branch}</span>
            {snapshot.workDirectory && <span className="selectable truncate font-mono text-ink-faint" title={snapshot.workDirectory}>· {snapshot.workDirectory}</span>}
            {config?.autoCommit && <span className="truncate text-ink-faint">{snapshot.remoteUrl ? `→ ${snapshot.remoteUrl}` : '(commits locaux)'}</span>}
          </div>
        )}
        {snapshot.pendingInstruction && (
          <div className="text-[12px] text-ink-muted">
            Instruction en attente : <span className="selectable text-ink">{snapshot.pendingInstruction.slice(0, 300)}</span>
          </div>
        )}
        {snapshot.lastDecision?.rationale && <div className="text-[12px] text-ink-faint italic">GPT : {snapshot.lastDecision.rationale.slice(0, 400)}</div>}
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="GPT" value={`${usage.codexTurns} décision(s)`} detail={`${formatTokens(usage.codexInputTokens + usage.codexOutputTokens)} jetons`} />
          <Stat label="Claude" value={`${usage.claudeTurns} tâche(s)`} detail={`${formatTokens(usage.claudeInputTokens + usage.claudeOutputTokens)} jetons`} />
        </div>
      </div>
    </Section>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-line bg-sunken px-2.5 py-1.5">
      <div className="text-[10.5px] tracking-[0.08em] text-ink-faint uppercase">{label}</div>
      <div className="text-[12.5px] font-medium text-ink">{value}</div>
      <div className="text-[11px] text-ink-faint">{detail}</div>
    </div>
  )
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)} M`
  if (count >= 1000) return `${Math.round(count / 1000)} k`
  return String(count)
}

function Journal({ snapshot }: { snapshot: PilotSnapshot }) {
  const rounds = [...snapshot.rounds].reverse()
  const events = snapshot.events.slice(-15).reverse()
  if (rounds.length === 0 && events.length === 0) return null
  return (
    <div className="space-y-2">
      {rounds.length > 0 && <div className="px-0.5 font-display text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">Tâches</div>}
      {rounds.map((round) => (
        <RoundCard key={`${round.index}-${round.startedAt}`} round={round} />
      ))}
      {events.length > 0 && (
        <details className="group rounded-lg border border-line bg-panel px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-ink-muted marker:text-gold">Journal du pilote</summary>
          <ul className="mt-2 space-y-1 border-l border-line pl-2.5">
            {events.map((event) => (
              <li key={`${event.at}-${event.text}`} className={classNames('selectable text-[11.5px]', event.tone === 'error' ? 'text-danger' : event.tone === 'warning' ? 'text-warning' : event.tone === 'success' ? 'text-sage' : 'text-ink-muted')}>
                <span className="font-mono text-[10.5px] text-ink-faint">{new Date(event.at).toLocaleTimeString('fr-FR')} </span>
                {event.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function RoundCard({ round }: { round: PilotRound }) {
  const report = round.report
  const running = round.finishedAt === null
  const reportLabel = !report ? (running ? 'en cours' : 'sans rapport') : report.status === 'done' ? 'terminée' : report.status === 'partial' ? 'partielle' : 'bloquée'
  return (
    <details className={classNames('rounded-lg border bg-panel px-3 py-2 shadow-panel', running ? 'border-gold/40' : 'border-line')} open={running}>
      <summary className="flex cursor-pointer items-center gap-2 text-[12.5px] marker:text-gold">
        {running ? <Spinner className="size-3.5 text-gold" /> : round.claudeError ? <XCircle className="size-3.5 text-danger" /> : report?.status === 'done' ? <CheckCircle2 className="size-3.5 text-sage" /> : <CircleDot className="size-3.5 text-warning" />}
        <span className="font-display font-semibold text-ink">Tâche {round.index}</span>
        <span className="text-ink-faint">{reportLabel}</span>
        {round.commit?.sha && (
          <span className="ml-auto flex items-center gap-1 rounded-full border border-gold/30 bg-accent-soft px-1.5 font-mono text-[10.5px] text-gold">
            <GitCommit className="size-3" />
            {round.commit.sha.slice(0, 8)}
            {round.commit.pushed ? ' ↑' : ''}
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-2 text-[12px]">
        <div className="selectable whitespace-pre-wrap rounded-md bg-sunken px-2.5 py-2 text-ink-muted">{round.instruction}</div>
        {round.claudeError && <div className="selectable text-danger">{round.claudeError}</div>}
        {report && (
          <div className="selectable whitespace-pre-wrap text-ink">
            {report.summary}
            {report.blockers && <div className="mt-1 text-warning">Blocages : {report.blockers}</div>}
          </div>
        )}
        {round.checks.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {round.checks.map((check) => (
              <span key={check.command} title={check.outputTail.slice(-1200)} className={classNames('rounded-full border px-2 py-0.5 font-mono text-[10.5px]', check.passed ? 'border-sage/40 bg-sage/10 text-sage' : 'border-danger/40 bg-danger-soft text-danger')}>
                {check.passed ? '✓' : '✗'} {check.command}
              </span>
            ))}
          </div>
        )}
        {round.commit && !round.commit.sha && round.commit.note && (
          <div className="flex items-start gap-1 text-[11.5px] text-ink-faint">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {round.commit.note}
          </div>
        )}
        {round.commit?.sha && round.commit.note && <div className="text-[11.5px] text-warning">{round.commit.note}</div>}
      </div>
    </details>
  )
}
