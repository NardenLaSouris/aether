import { AlertTriangle, Cpu, FolderKanban, FolderPlus, History, LogIn, MessageSquarePlus, MessagesSquare, RefreshCw } from 'lucide-react'
import { APP_CONFIG } from '../../../shared/appConfig'
import { LIMIT_LABELS, evaluateBlock, formatDuration } from '../../../shared/quota'
import { Logo } from '../components/chrome'
import { InstallGuide } from '../components/InstallGuide'
import { useNow } from '../components/workspace'
import { Badge, Button, Card } from '../components/ui'
import { formatRelative, shortPath } from '../lib/format'
import { useAppStore } from '../stores/appStore'

function EngineCard() {
  const installation = useAppStore((state) => state.installation)
  const auth = useAppStore((state) => state.auth)
  const engine = useAppStore((state) => state.engine)
  const account = useAppStore((state) => state.account)
  const navigate = useAppStore((state) => state.navigate)
  const refresh = useAppStore((state) => state.refreshEnvironment)
  return (
    <Card title="Moteur Claude Code" actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()}>Vérifier</Button>}>
      {!installation ? (
        <div className="text-xs text-ink-faint">Détection en cours…</div>
      ) : !installation.found ? (
        <InstallGuide compact />
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-ink-faint">Version</dt>
          <dd>{installation.version}</dd>
          <dt className="text-ink-faint">Exécutable</dt>
          <dd className="truncate font-mono text-xs" title={installation.executablePath ?? ''}>{shortPath(installation.executablePath ?? '', 56)}</dd>
          <dt className="text-ink-faint">Processus moteur</dt>
          <dd>{engine.hostState === 'running' ? <Badge tone="sage">Actif</Badge> : <Badge tone={engine.hostState === 'failed' || engine.hostState === 'crashed' ? 'danger' : 'neutral'}>{engine.hostState}</Badge>}</dd>
          <dt className="text-ink-faint">Compte</dt>
          <dd>
            {auth?.loggedIn ? (
              <span>
                {auth.email ?? account?.email ?? 'Connecté'} {(auth.subscriptionType ?? account?.subscriptionType) && <Badge tone="gold">{auth.subscriptionType ?? account?.subscriptionType}</Badge>}
              </span>
            ) : auth?.checked ? (
              <Button size="sm" variant="subtle" icon={<LogIn className="size-3.5" />} onClick={() => navigate('settings')}>
                Se connecter
              </Button>
            ) : (
              '…'
            )}
          </dd>
        </dl>
      )}
    </Card>
  )
}

function ModelAndQuotaCard() {
  const models = useAppStore((state) => state.models)
  const defaultModel = useAppStore((state) => state.preferences?.defaultModel ?? null)
  const quota = useAppStore((state) => state.quota)
  const navigate = useAppStore((state) => state.navigate)
  const now = useNow(1000)
  const defaultLabel = defaultModel ? (models.find((model) => model.value === defaultModel)?.displayName ?? defaultModel) : 'Choix de Claude Code'
  const evaluation = evaluateBlock(quota.block, now)
  const fiveHour = quota.windows.find((window) => window.kind === 'five_hour')
  const sevenDay = quota.windows.find((window) => window.kind === 'seven_day')
  const nextReset = [fiveHour, sevenDay].filter((window) => window?.resetsAt && window.resetsAt > now).sort((left, right) => (left?.resetsAt ?? 0) - (right?.resetsAt ?? 0))[0]
  return (
    <Card title="Modèle et consommation" actions={<Button size="sm" variant="ghost" onClick={() => navigate('usage')}>Tableau de bord</Button>}>
      <div className="space-y-3 text-[13px]">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-sage" />
          <span className="text-ink-faint">Modèle par défaut :</span> <span>{defaultLabel}</span>
        </div>
        {quota.block && evaluation.blocked ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-warning">
            <AlertTriangle className="mt-0.5 size-4" />
            <span>
              {LIMIT_LABELS[quota.block.limitKind]} atteinte. {evaluation.millisecondsRemaining !== null ? `Reprise dans ${formatDuration(evaluation.millisecondsRemaining)}.` : 'Heure de reprise inconnue.'}
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {[fiveHour, sevenDay].map((window, index) => (
              <div key={index} className="rounded-md border border-line bg-sunken px-3 py-2">
                <div className="text-[11px] text-ink-faint">{index === 0 ? LIMIT_LABELS.five_hour : LIMIT_LABELS.seven_day}</div>
                <div className="mt-0.5 font-display text-lg">{window?.utilizationPercent != null ? `${Math.round(window.utilizationPercent)} %` : '—'}</div>
                <div className="text-[11px] text-ink-faint">{window?.resetsAt ? `Réinit. ${new Date(window.resetsAt).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Non communiqué'}</div>
              </div>
            ))}
          </div>
        )}
        {nextReset?.resetsAt && <div className="text-xs text-ink-faint">Prochaine réinitialisation connue : {new Date(nextReset.resetsAt).toLocaleString('fr-FR')}</div>}
        {quota.rateLimitsAvailable === false && <div className="text-xs text-ink-faint">Quota non disponible via l’interface officielle pour ce type de compte.</div>}
      </div>
    </Card>
  )
}

export function HomePage() {
  const conversations = useAppStore((state) => state.conversations)
  const projects = useAppStore((state) => state.projects)
  const sessions = useAppStore((state) => state.sessions)
  const open = useAppStore((state) => state.openConversation)
  const create = useAppStore((state) => state.createConversation)
  const addProject = useAppStore((state) => state.addProject)
  const openSession = useAppStore((state) => state.openSession)
  const navigate = useAppStore((state) => state.navigate)
  const unlinkedSessions = sessions.filter((session) => !session.linkedConversationId).slice(0, 5)
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <div className="flex items-center gap-4">
          <Logo size={40} />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">{APP_CONFIG.name}</h1>
            <p className="text-[13px] text-ink-muted">{APP_CONFIG.tagline}</p>
          </div>
          <div className="flex-1" />
          <Button variant="secondary" icon={<FolderPlus className="size-4" />} onClick={() => void addProject()}>
            Ajouter un projet
          </Button>
          <Button variant="primary" icon={<MessageSquarePlus className="size-4" />} onClick={() => void create(null)}>
            Nouvelle conversation
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-5">
          <EngineCard />
          <ModelAndQuotaCard />
        </div>
        <div className="grid grid-cols-3 gap-5">
          <Card title={<span className="flex items-center gap-2"><MessagesSquare className="size-4 text-sage" />Conversations récentes</span>} actions={<Button size="sm" variant="ghost" onClick={() => navigate('conversations')}>Tout voir</Button>}>
            {conversations.length === 0 ? <div className="text-xs text-ink-faint">Aucune conversation pour l’instant.</div> : null}
            <ul className="space-y-1">
              {conversations.slice(0, 6).map((conversation) => (
                <li key={conversation.id}>
                  <button type="button" onClick={() => void open(conversation.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/4">
                    <span className="truncate text-[13px]">{conversation.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-ink-faint">{formatRelative(conversation.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={<span className="flex items-center gap-2"><FolderKanban className="size-4 text-sage" />Projets récents</span>} actions={<Button size="sm" variant="ghost" onClick={() => navigate('projects')}>Tout voir</Button>}>
            {projects.length === 0 ? <div className="text-xs text-ink-faint">Ajoutez un dossier local pour y travailler avec Claude.</div> : null}
            <ul className="space-y-1">
              {projects.slice(0, 6).map((project) => (
                <li key={project.id}>
                  <button type="button" onClick={() => void create(project.id)} className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-white/4" title="Nouvelle conversation dans ce projet">
                    <span className="truncate text-[13px]">{project.name}</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint">{shortPath(project.directoryPath, 44)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={<span className="flex items-center gap-2"><History className="size-4 text-sage" />Sessions Claude Code</span>} actions={<Button size="sm" variant="ghost" onClick={() => navigate('sessions')}>Tout voir</Button>}>
            {unlinkedSessions.length === 0 ? <div className="text-xs text-ink-faint">Aucune session locale non reprise.</div> : null}
            <ul className="space-y-1">
              {unlinkedSessions.map((session) => (
                <li key={session.sessionId}>
                  <button type="button" disabled={!session.cwdExists} onClick={() => void openSession(session.sessionId)} className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-white/4 disabled:opacity-50">
                    <span className="truncate text-[13px]">{session.customTitle || session.summary}</span>
                    <span className="text-[11px] text-ink-faint">{formatRelative(session.lastModified)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
