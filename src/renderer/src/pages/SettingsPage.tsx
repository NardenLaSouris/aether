import { Archive, Bell, Cpu, Database, FileSearch, FolderOpen, LogIn, Palette, RefreshCw, RotateCcw, ScrollText, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { SELECTABLE_PERMISSION_MODES} from '../../../shared/domain';
import { EFFORT_LEVELS, type EffortLevel, type LogRecord, type ThemePreference } from '../../../shared/domain'
import { InstallGuide } from '../components/InstallGuide'
import { confirmBypassMode } from '../components/workspace'
import { effortLabel } from '../components/ComposerExtras'
import { Badge, Button, Card, classNames, Toggle } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useAppStore } from '../stores/appStore'

type SectionId = 'auth' | 'engine' | 'models' | 'appearance' | 'notifications' | 'sessions' | 'diagnostics'

const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: 'auth', label: 'Authentification', icon: <UserRound className="size-4" /> },
  { id: 'engine', label: 'Moteur', icon: <Cpu className="size-4" /> },
  { id: 'models', label: 'Modèle et permissions', icon: <ShieldCheck className="size-4" /> },
  { id: 'appearance', label: 'Thème', icon: <Palette className="size-4" /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell className="size-4" /> },
  { id: 'sessions', label: 'Sessions et quotas', icon: <Archive className="size-4" /> },
  { id: 'diagnostics', label: 'Diagnostic et journaux', icon: <ScrollText className="size-4" /> }
]

function AuthSection() {
  const auth = useAppStore((state) => state.auth)
  const installation = useAppStore((state) => state.installation)
  const toast = useAppStore((state) => state.toast)
  const refresh = useAppStore((state) => state.refreshEnvironment)
  const [launching, setLaunching] = useState(false)
  const login = async (method: 'claudeai' | 'console'): Promise<void> => {
    setLaunching(true)
    try {
      const result = await api.invoke('engine:open-login', { method })
      if (result.launched) toast({ tone: 'info', title: 'Connexion officielle ouverte', body: 'Terminez la connexion dans la fenêtre Claude Code et votre navigateur, puis cliquez sur « Vérifier ».' })
      else toast({ tone: 'error', title: 'Impossible de lancer la connexion', body: result.error })
    } finally {
      setLaunching(false)
    }
  }
  return (
    <Card title="Authentification" actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()}>Vérifier</Button>}>
      <div className="space-y-4 text-[13px]">
        <p className="text-ink-muted">L’authentification est entièrement gérée par Claude Code (OAuth officiel ou clé de la Console Anthropic). {useAppStore.getState().appName} ne voit, ne stocke et ne transmet aucun identifiant.</p>
        {auth?.loggedIn ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-faint">État</dt>
            <dd><Badge tone="sage">Connecté</Badge></dd>
            {auth.email && (<><dt className="text-ink-faint">Compte</dt><dd>{auth.email}</dd></>)}
            {auth.authMethod && (<><dt className="text-ink-faint">Méthode</dt><dd>{auth.authMethod}</dd></>)}
            {auth.subscriptionType && (<><dt className="text-ink-faint">Abonnement</dt><dd>{auth.subscriptionType}</dd></>)}
            {auth.loginExpiresAt && (<><dt className="text-ink-faint">Expiration de la connexion</dt><dd>{formatDateTime(Date.parse(auth.loginExpiresAt))}</dd></>)}
          </dl>
        ) : (
          <div className="text-warning">{auth?.checked ? (auth.error ?? 'Vous n’êtes pas connecté à Claude Code.') : 'État inconnu.'}</div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<LogIn className="size-4" />} loading={launching} disabled={!installation?.found} onClick={() => void login('claudeai')}>
            {auth?.loggedIn ? 'Changer de compte (abonnement Claude)' : 'Se connecter avec un abonnement Claude'}
          </Button>
          <Button variant="secondary" disabled={!installation?.found} onClick={() => void login('console')}>
            Se connecter avec la Console Anthropic (API)
          </Button>
        </div>
        <p className="text-[11px] text-ink-faint">Ces boutons ouvrent la commande officielle <code className="font-mono">claude auth login</code> dans une fenêtre de terminal séparée.</p>
      </div>
    </Card>
  )
}

function EngineSection() {
  const installation = useAppStore((state) => state.installation)
  const engine = useAppStore((state) => state.engine)
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  const toast = useAppStore((state) => state.toast)
  return (
    <Card title="Moteur Claude Code">
      <div className="space-y-4 text-[13px]">
        {installation?.found ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-faint">Version</dt>
            <dd>{installation.version}</dd>
            <dt className="text-ink-faint">Exécutable</dt>
            <dd className="selectable font-mono text-xs break-all">{installation.executablePath}</dd>
            <dt className="text-ink-faint">Détection</dt>
            <dd>{{ preference: 'chemin personnalisé', path: 'variable PATH', 'known-location': 'emplacement standard', none: '—' }[installation.detectionSource]}</dd>
            <dt className="text-ink-faint">Processus moteur</dt>
            <dd>
              {engine.hostState} · {engine.activeRunners} session(s) active(s) · {engine.restartCount} redémarrage(s)
              {engine.lastError && <div className="text-xs text-danger">{engine.lastError}</div>}
            </dd>
          </dl>
        ) : (
          <InstallGuide />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderOpen className="size-3.5" />}
            onClick={async () => {
              const picked = await api.invoke('preferences:pick-executable')
              if (picked) await updatePreferences({ claudeExecutablePath: picked })
            }}
          >
            Choisir un exécutable…
          </Button>
          {preferences?.claudeExecutablePath && (
            <Button size="sm" variant="ghost" onClick={() => void updatePreferences({ claudeExecutablePath: null })}>
              Revenir à la détection automatique
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-3.5" />}
            onClick={async () => {
              try {
                await api.invoke('engine:restart')
                toast({ tone: 'success', title: 'Moteur redémarré' })
              } catch (error) {
                toast({ tone: 'error', title: 'Redémarrage impossible', body: errorMessage(error) })
              }
            }}
          >
            Redémarrer le moteur
          </Button>
        </div>
        <p className="text-[11px] text-ink-faint">Le moteur s’exécute dans un processus isolé. En cas d’arrêt inattendu il est relancé automatiquement (5 fois par minute au maximum) et les sessions reprennent au message suivant grâce au mécanisme officiel de reprise.</p>
      </div>
    </Card>
  )
}

function ModelsSection() {
  const models = useAppStore((state) => state.models)
  const modelsError = useAppStore((state) => state.modelsError)
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  const refreshModels = useAppStore((state) => state.refreshModels)
  if (!preferences) return null
  const defaultMissing = preferences.defaultModel !== null && models.length > 0 && !models.some((model) => model.value === preferences.defaultModel)
  return (
    <Card title="Modèle et permissions" actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void refreshModels()}>Actualiser la liste</Button>}>
      <div className="space-y-4 text-[13px]">
        <label className="block">
          <span className="text-ink-muted">Modèle par défaut des nouvelles conversations</span>
          <select value={preferences.defaultModel ?? ''} onChange={(event) => void updatePreferences({ defaultModel: event.target.value || null })} className="mt-1.5 block w-full rounded-md border border-line-strong bg-sunken px-2.5 py-2 text-[13px] outline-none focus:border-gold/50">
            <option value="">Choix de Claude Code</option>
            {models.map((model) => (
              <option key={model.value} value={model.value}>
                {model.displayName} — {model.description}
              </option>
            ))}
            {defaultMissing && <option value={preferences.defaultModel ?? ''}>{preferences.defaultModel} (indisponible)</option>}
          </select>
        </label>
        {modelsError && <div className="text-xs text-warning">Liste des modèles indisponible : {modelsError}</div>}
        {defaultMissing && <div className="text-xs text-warning">Le modèle par défaut enregistré n’est plus proposé par Claude Code.</div>}
        <p className="text-[11px] text-ink-faint">La liste provient de Claude Code (<code className="font-mono">supportedModels</code>) et dépend de votre compte. Elle n’est jamais codée en dur.</p>
        <label className="block">
          <span className="text-ink-muted">Mode de permission par défaut</span>
          <select value={preferences.defaultPermissionMode} onChange={(event) => {
              const mode = event.target.value as (typeof SELECTABLE_PERMISSION_MODES)[number]
              if (mode === 'bypassPermissions') void confirmBypassMode().then((confirmed) => {
                  if (confirmed) void updatePreferences({ defaultPermissionMode: mode })
                })
              else void updatePreferences({ defaultPermissionMode: mode })
            }} className="mt-1.5 block w-full rounded-md border border-line-strong bg-sunken px-2.5 py-2 text-[13px] outline-none focus:border-gold/50">
            <option value="default">Demander l’autorisation (recommandé)</option>
            <option value="acceptEdits">Accepter automatiquement les modifications de fichiers</option>
            <option value="plan">Planification uniquement</option>
            <option value="bypassPermissions">Tout autoriser, sans aucune demande</option>
          </select>
        </label>
        <p className="text-[11px] text-ink-faint">« Tout autoriser » est demandé avec confirmation et équivaut à claude --dangerously-skip-permissions. Les règles de permission de vos fichiers de configuration Claude Code s’appliquent toujours.</p>
        <label className="block">
          <span className="text-ink-muted">Effort de réflexion par défaut</span>
          <select value={preferences.defaultEffort ?? ''} onChange={(event) => void updatePreferences({ defaultEffort: (event.target.value || null) as EffortLevel | null })} className="mt-1.5 block w-full rounded-md border border-line-strong bg-sunken px-2.5 py-2 text-[13px] outline-none focus:border-gold/50">
            <option value="">Choix du modèle</option>
            {EFFORT_LEVELS.map((effort) => (
              <option key={effort} value={effort}>
                {effortLabel(effort)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-ink-faint">Comme /effort dans Claude Code. Chaque conversation peut avoir le sien (sélecteur à côté du modèle). Plus d’effort donne des réponses plus réfléchies, plus lentes et plus coûteuses.</p>
      </div>
    </Card>
  )
}

function AppearanceSection() {
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  if (!preferences) return null
  const options: { value: ThemePreference; label: string; swatch: string }[] = [
    { value: 'forest', label: 'Forêt', swatch: 'bg-forest' },
    { value: 'charcoal', label: 'Charbon', swatch: 'bg-charcoal' },
    { value: 'system', label: 'Par défaut (Forêt)', swatch: 'bg-gradient-to-br from-forest to-charcoal' }
  ]
  return (
    <Card title="Thème">
      <div className="flex gap-3">
        {options.map((option) => (
          <button key={option.value} type="button" onClick={() => void updatePreferences({ theme: option.value })} className={classNames('flex w-36 flex-col gap-2 rounded-md border p-2 text-left text-[13px]', preferences.theme === option.value ? 'border-gold/60 bg-accent-soft' : 'border-line hover:border-line-strong')}>
            <span className={classNames('h-14 rounded border border-white/10', option.swatch)} />
            {option.label}
          </button>
        ))}
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <Toggle checked={preferences.sendWithEnter} onChange={(sendWithEnter) => void updatePreferences({ sendWithEnter })} label="Envoyer avec Entrée" description="Désactivé : Ctrl+Entrée pour envoyer. Maj+Entrée insère toujours une nouvelle ligne." />
      </div>
    </Card>
  )
}

function NotificationsSection() {
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  if (!preferences) return null
  return (
    <Card title="Notifications">
      <Toggle checked={preferences.notificationsEnabled} onChange={(notificationsEnabled) => void updatePreferences({ notificationsEnabled })} label="Notifications Windows" description="Limites atteintes, reprise des envois, autorisations en attente." />
      <Toggle checked={preferences.notifyOnTurnComplete} onChange={(notifyOnTurnComplete) => void updatePreferences({ notifyOnTurnComplete })} label="Fin de réponse" description="Prévenir quand Claude termine alors que la fenêtre n’est pas au premier plan." />
    </Card>
  )
}

function SessionsSection() {
  const preferences = useAppStore((state) => state.preferences)
  const updatePreferences = useAppStore((state) => state.updatePreferences)
  if (!preferences) return null
  return (
    <Card title="Sessions et quotas">
      <Toggle checked={preferences.autoRefreshSessions} onChange={(autoRefreshSessions) => void updatePreferences({ autoRefreshSessions })} label="Actualiser automatiquement les sessions Claude Code" description="Relit la liste toutes les 60 secondes (lecture seule)." />
      <p className="mt-2 text-[11px] text-ink-faint">Quand une limite d’usage est atteinte, les envois sont suspendus jusqu’à l’heure communiquée par Claude Code. Si elle n’est pas communiquée, une vérification via l’interface officielle est effectuée toutes les 15 minutes, sans jamais renvoyer la requête refusée.</p>
    </Card>
  )
}

function DiagnosticsSection() {
  const dataDirectory = useAppStore((state) => state.dataDirectory)
  const appVersion = useAppStore((state) => state.appVersion)
  const toast = useAppStore((state) => state.toast)
  const [logs, setLogs] = useState<LogRecord[]>([])
  const [levelFilter, setLevelFilter] = useState<'all' | 'warn' | 'error'>('all')
  const loadLogs = async (): Promise<void> => setLogs(await api.invoke('diagnostics:logs', { limit: 300 }))
  useEffect(() => {
    void loadLogs()
  }, [])
  const visible = logs.filter((log) => levelFilter === 'all' || (levelFilter === 'warn' ? log.level === 'warn' || log.level === 'error' : log.level === 'error'))
  const levelTone = { debug: 'text-ink-faint', info: 'text-info', warn: 'text-warning', error: 'text-danger' }
  return (
    <Card title="Diagnostic et journaux">
      <div className="space-y-3 text-[13px]">
        <div className="text-ink-muted">
          Version {appVersion} · données : <span className="selectable font-mono text-xs">{dataDirectory}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<FolderOpen className="size-3.5" />} onClick={() => void api.invoke('diagnostics:open-data-folder')}>
            Ouvrir le dossier des données
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Database className="size-3.5" />}
            onClick={async () => {
              try {
                const result = await api.invoke('diagnostics:backup')
                toast({ tone: 'success', title: 'Sauvegarde créée', body: result.filePath })
              } catch (error) {
                toast({ tone: 'error', title: 'Sauvegarde impossible', body: errorMessage(error) })
              }
            }}
          >
            Sauvegarder la base
          </Button>
          <Button size="sm" variant="ghost" icon={<FileSearch className="size-3.5" />} onClick={() => void loadLogs()}>
            Actualiser les journaux
          </Button>
          <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as typeof levelFilter)} className="h-7 rounded-md border border-line bg-sunken px-2 text-xs">
            <option value="all">Tous niveaux</option>
            <option value="warn">Avertissements et erreurs</option>
            <option value="error">Erreurs</option>
          </select>
        </div>
        <div className="selectable max-h-96 overflow-y-auto rounded-md border border-line bg-sunken p-2 font-mono text-[11px]">
          {visible.length === 0 && <div className="p-2 text-ink-faint">Aucune entrée.</div>}
          {visible.map((log) => (
            <details key={log.id} className="border-b border-line/50 py-1 last:border-0">
              <summary className="cursor-pointer">
                <span className="text-ink-faint">{new Date(log.createdAt).toLocaleString('fr-FR')}</span> <span className={levelTone[log.level]}>{log.level.toUpperCase()}</span> <span className="text-sage">{log.scope}</span> {log.message}
              </summary>
              {log.details && <pre className="mt-1 whitespace-pre-wrap text-ink-faint">{log.details}</pre>}
            </details>
          ))}
        </div>
      </div>
    </Card>
  )
}

export function SettingsPage() {
  const [section, setSection] = useState<SectionId>('auth')
  const content: Record<SectionId, ReactNode> = {
    auth: <AuthSection />,
    engine: <EngineSection />,
    models: <ModelsSection />,
    appearance: <AppearanceSection />,
    notifications: <NotificationsSection />,
    sessions: <SessionsSection />,
    diagnostics: <DiagnosticsSection />
  }
  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 border-r border-line bg-panel/50 p-3">
        <h1 className="px-2 pt-2 pb-3 font-display text-lg font-semibold">Paramètres</h1>
        {SECTIONS.map((entry) => (
          <button key={entry.id} type="button" onClick={() => setSection(entry.id)} className={classNames('mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px]', section === entry.id ? 'bg-forest/70 text-gold' : 'text-ink-muted hover:bg-white/4 hover:text-ink')}>
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto max-w-3xl">{content[section]}</div>
      </div>
    </div>
  )
}
