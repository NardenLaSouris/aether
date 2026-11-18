/**
 * Plugins, mods and skills from Claude Code, with on/off switches that apply to Aether sessions only.
 */
import { ChevronDown, ChevronRight, Puzzle, RefreshCw, RotateCcw, Search, Sparkles, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ExtensionCatalog, ModEntry, PluginEntry, SkillEntry } from '../../../shared/domain'
import { Badge, Button, classNames, EmptyState, IconButton, Spinner, Switch, Tooltip } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatRelative } from '../lib/format'
import { AetherModList } from '../mods/AetherModList'
import { useModsStore } from '../mods/modsStore'
import { useAppStore } from '../stores/appStore'

type TabId = 'plugins' | 'mods' | 'skills' | 'aether'
type SkillFilter = 'all' | 'enabled' | 'disabled'
type Change = { kind: 'plugin' | 'mod' | 'skill'; key: string; enabled: boolean | null }

const OWN_GROUP = '__own__'
const BUILTIN_GROUP = '__builtin__'

function applyLocally(catalog: ExtensionCatalog, changes: Change[]): ExtensionCatalog {
  const lookup = (kind: Change['kind'], key: string) => changes.find((change) => change.kind === kind && change.key === key)
  return {
    ...catalog,
    plugins: catalog.plugins.map((plugin) => {
      const change = lookup('plugin', plugin.id)
      if (!change) return plugin
      const enabled = change.enabled ?? plugin.enabledInClaudeCode
      return { ...plugin, enabled, overridden: enabled !== plugin.enabledInClaudeCode }
    }),
    mods: catalog.mods.map((mod) => {
      const change = lookup('mod', mod.name)
      if (!change) return mod
      const enabled = change.enabled ?? true
      return { ...mod, enabled, overridden: !enabled }
    }),
    skills: catalog.skills.map((skill) => {
      const change = lookup('skill', skill.name)
      if (!change) return skill
      const enabled = change.enabled ?? true
      return { ...skill, enabled, overridden: !enabled }
    })
  }
}

export function ExtensionsPage() {
  const projects = useAppStore((state) => state.projects)
  const loadProjects = useAppStore((state) => state.loadProjects)
  const toast = useAppStore((state) => state.toast)
  const [tab, setTab] = useState<TabId>('plugins')
  const [directory, setDirectory] = useState<string>('')
  const [catalog, setCatalog] = useState<ExtensionCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(
    async (options: { refreshPlugins?: boolean; refreshSkills?: boolean } = {}) => {
      setLoading(true)
      try {
        setCatalog(await api.invoke('extensions:catalog', { ...(directory ? { workingDirectory: directory } : {}), ...options }))
      } catch (error) {
        toast({ tone: 'error', title: 'Lecture des extensions impossible', body: errorMessage(error) })
      } finally {
        setLoading(false)
      }
    },
    [directory, toast]
  )

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    void load()
  }, [load])

  const applyChanges = async (changes: Change[]) => {
    if (!catalog || changes.length === 0) return
    const previous = catalog
    setCatalog(applyLocally(catalog, changes))
    setSaving(true)
    try {
      const result = await api.invoke('extensions:update', { changes })
      const parts = ['S’applique aux prochains messages des conversations Aether.']
      if (result.reloadedConversations > 0) parts.push(`${result.reloadedConversations} conversation(s) ouverte(s) rechargée(s), contexte conservé.`)
      if (result.busyConversations > 0) parts.push(`${result.busyConversations} conversation(s) en cours de génération garderont l’ancien réglage jusqu’à leur redémarrage.`)
      toast({ tone: 'success', title: 'Extensions mises à jour', body: parts.join(' ') })
      // Turning a plugin or mod on/off changes which skills exist: read them again from Claude Code.
      if (changes.some((change) => change.kind !== 'skill')) await load()
    } catch (error) {
      setCatalog(previous)
      toast({ tone: 'error', title: 'Modification refusée', body: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  const disabledCount = (items: { enabled: boolean }[]) => items.filter((item) => !item.enabled).length
  const aetherMods = useModsStore((state) => state.catalog?.mods) ?? []

  const tabs: { id: TabId; label: string; count: number; disabled: number }[] = [
    { id: 'plugins', label: 'Plugins', count: catalog?.plugins.length ?? 0, disabled: disabledCount(catalog?.plugins ?? []) },
    { id: 'mods', label: 'Mods Claude Code', count: catalog?.mods.length ?? 0, disabled: disabledCount(catalog?.mods ?? []) },
    { id: 'skills', label: 'Skills et commandes', count: catalog?.skills.length ?? 0, disabled: disabledCount(catalog?.skills ?? []) },
    { id: 'aether', label: 'Mods Aether', count: aetherMods.length, disabled: disabledCount(aetherMods) }
  ]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold">Extensions</h1>
          {(loading || saving) && <Spinner />}
          <div className="flex-1" />
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            Dossier
            <select aria-label="Dossier lu pour les skills" value={directory} onChange={(event) => setDirectory(event.target.value)} className="no-drag h-8 max-w-64 rounded-md border border-line-strong bg-sunken px-2 text-[12px] text-ink">
              <option value="">Dossier par défaut</option>
              {projects.map((project) => (
                <option key={project.id} value={project.directoryPath}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} disabled={loading} onClick={() => void load({ refreshPlugins: true, refreshSkills: true })}>
            Actualiser
          </Button>
        </div>
        <p className="mb-5 max-w-3xl text-[13px] text-ink-muted">
          Les plugins, mods et skills de votre Claude Code. Vos choix ici ne valent que pour les sessions lancées par Aether : la configuration de Claude Code n’est jamais modifiée, et vos sessions dans le terminal restent comme avant.
        </p>

        {catalog && catalog.errors.length > 0 && (
          <div className="mb-4 rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-[12.5px] text-warning">
            {catalog.errors.map((error) => (
              <div key={error} className="selectable">
                {error}
              </div>
            ))}
          </div>
        )}

        <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={classNames('-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] transition-colors', tab === entry.id ? 'border-gold text-ink' : 'border-transparent text-ink-muted hover:text-ink')}
            >
              {entry.label}
              <span className="rounded-full bg-white/6 px-1.5 text-[11px] text-ink-faint">{entry.count}</span>
              {entry.disabled > 0 && <Badge tone="warning">{entry.disabled} désactivé{entry.disabled > 1 ? 's' : ''}</Badge>}
            </button>
          ))}
        </div>

        {tab === 'aether' ? (
          <AetherModList />
        ) : !catalog ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : tab === 'plugins' ? (
          <PluginList plugins={catalog.plugins} disabled={saving} onChange={applyChanges} />
        ) : tab === 'mods' ? (
          <ModList mods={catalog.mods} disabled={saving} onChange={applyChanges} />
        ) : (
          <SkillList catalog={catalog} loading={loading} disabled={saving} onChange={applyChanges} />
        )}
      </div>
    </div>
  )
}

function Row({ title, subtitle, description, badges, control }: { title: string; subtitle?: string; description?: string | null; badges?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-[13.5px] font-semibold">{title}</span>
          {subtitle && <span className="font-mono text-[11px] text-ink-faint">{subtitle}</span>}
          {badges}
        </div>
        {description && <div className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{control}</div>
    </div>
  )
}

function ResetButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <IconButton label="Revenir au réglage de Claude Code" disabled={disabled} onClick={onClick}>
      <RotateCcw className="size-3.5" />
    </IconButton>
  )
}

function PluginList({ plugins, disabled, onChange }: { plugins: PluginEntry[]; disabled: boolean; onChange: (changes: Change[]) => Promise<void> }) {
  if (plugins.length === 0) return <EmptyState icon={<Puzzle className="size-5" />} title="Aucun plugin installé" description="Installez des plugins avec Claude Code (/plugin) ; ils apparaîtront ici." />
  return (
    <div className="divide-y divide-line rounded-lg border border-line bg-panel shadow-panel">
      {plugins.map((plugin) => (
        <Row
          key={plugin.id}
          title={plugin.name}
          subtitle={[plugin.id, plugin.version ? `v${plugin.version}` : null].filter(Boolean).join(' · ')}
          description={plugin.description}
          badges={
            <>
              <Badge tone={plugin.enabledInClaudeCode ? 'sage' : 'neutral'}>{plugin.enabledInClaudeCode ? 'activé dans Claude Code' : 'désactivé dans Claude Code'}</Badge>
              {plugin.overridden && <Badge tone="gold">réglage Aether</Badge>}
            </>
          }
          control={
            <>
              {plugin.overridden && <ResetButton disabled={disabled} onClick={() => void onChange([{ kind: 'plugin', key: plugin.id, enabled: null }])} />}
              <Switch checked={plugin.enabled} disabled={disabled} label={`${plugin.enabled ? 'Désactiver' : 'Activer'} ${plugin.name} dans Aether`} onChange={(enabled) => void onChange([{ kind: 'plugin', key: plugin.id, enabled }])} />
            </>
          }
        />
      ))}
    </div>
  )
}

function ModList({ mods, disabled, onChange }: { mods: ModEntry[]; disabled: boolean; onChange: (changes: Change[]) => Promise<void> }) {
  if (mods.length === 0) return <EmptyState icon={<Wand2 className="size-5" />} title="Aucun mod trouvé" description="Aether cherche vos mods dans le dossier dev-mods de Claude Code." />
  return (
    <>
      <p className="mb-3 text-[12.5px] text-ink-muted">
        Les mods activés sont chargés comme plugins locaux dans chaque session Aether : leurs hooks, commandes et outils fonctionnent. Leurs éléments d’interface (bandeaux, barre d’état, notifications) sont dessinés par l’interface de Claude Code et ne s’affichent pas dans Aether.
      </p>
      <div className="divide-y divide-line rounded-lg border border-line bg-panel shadow-panel">
        {mods.map((mod) => (
          <Row
            key={mod.name}
            title={mod.name}
            subtitle={mod.version ? `v${mod.version}` : undefined}
            description={mod.description}
            badges={
              <>
                {mod.hasUiHooks && (
                  <Tooltip content="Une partie de ce mod dessine dans l’interface de Claude Code ; cette partie n’apparaît pas dans Aether.">
                    <Badge tone="info">interface Claude Code</Badge>
                  </Tooltip>
                )}
                {mod.overridden && <Badge tone="gold">réglage Aether</Badge>}
              </>
            }
            control={<Switch checked={mod.enabled} disabled={disabled} label={`${mod.enabled ? 'Désactiver' : 'Activer'} le mod ${mod.name}`} onChange={(enabled) => void onChange([{ kind: 'mod', key: mod.name, enabled }])} />}
          />
        ))}
      </div>
    </>
  )
}

function SkillList({ catalog, loading, disabled, onChange }: { catalog: ExtensionCatalog; loading: boolean; disabled: boolean; onChange: (changes: Change[]) => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [OWN_GROUP]: true })

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = catalog.skills.filter((skill) => {
      if (filter === 'enabled' && !skill.enabled) return false
      if (filter === 'disabled' && skill.enabled) return false
      return !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)
    })
    const byGroup = new Map<string, SkillEntry[]>()
    for (const skill of visible) {
      const key = skill.builtin ? BUILTIN_GROUP : (skill.owner ?? OWN_GROUP)
      byGroup.set(key, [...(byGroup.get(key) ?? []), skill])
    }
    const order = (key: string) => (key === OWN_GROUP ? 0 : key === BUILTIN_GROUP ? 2 : 1)
    return [...byGroup.entries()].sort(([left], [right]) => order(left) - order(right) || left.localeCompare(right))
  }, [catalog.skills, filter, query])

  if (catalog.skills.length === 0) {
    return loading ? (
      <div className="flex flex-col items-center gap-3 py-16 text-[13px] text-ink-muted">
        <Spinner />
        Lecture des skills auprès de Claude Code…
      </div>
    ) : (
      <EmptyState icon={<Sparkles className="size-5" />} title="Aucun skill lu" description="Claude Code n’a renvoyé aucun skill pour ce dossier. Vérifiez que Claude Code est installé et connecté, puis actualisez." />
    )
  }

  const searching = query.trim().length > 0 || filter !== 'all'
  const groupLabel = (key: string) => (key === OWN_GROUP ? 'Vos skills et commandes' : key === BUILTIN_GROUP ? 'Intégrés à Claude Code' : `Plugin ou mod « ${key} »`)

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex h-8 min-w-64 flex-1 items-center gap-2 rounded-md border border-line-strong bg-sunken px-2.5">
          <Search className="size-3.5 text-ink-faint" />
          <input aria-label="Rechercher un skill" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un skill ou une commande…" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint" />
        </div>
        {(['all', 'enabled', 'disabled'] as const).map((value) => (
          <button key={value} type="button" onClick={() => setFilter(value)} className={classNames('h-8 rounded-md border px-2.5 text-[12px]', filter === value ? 'border-gold/50 bg-accent-soft text-gold' : 'border-line text-ink-muted hover:text-ink')}>
            {value === 'all' ? 'Tous' : value === 'enabled' ? 'Activés' : 'Désactivés'}
          </button>
        ))}
      </div>
      <p className="mb-3 text-[12px] text-ink-faint">
        Lu auprès de Claude Code {catalog.skillsReadAt ? formatRelative(catalog.skillsReadAt) : ''}
        {catalog.skillsDirectory ? ` pour ${catalog.skillsDirectory}` : ''}. Un skill désactivé est retiré de la liste proposée à Claude et refusé s’il est appelé ; ses fichiers restent sur le disque.
      </p>
      {groups.length === 0 && <div className="py-10 text-center text-[13px] text-ink-muted">Aucun résultat.</div>}
      <div className="flex flex-col gap-3">
        {groups.map(([key, skills]) => {
          const open = searching || expanded[key] === true
          const disabledInGroup = skills.filter((skill) => !skill.enabled).length
          return (
            <section key={key} className="rounded-lg border border-line bg-panel shadow-panel">
              <header className="flex items-center gap-2 px-3 py-2">
                <button type="button" aria-expanded={open} onClick={() => setExpanded((state) => ({ ...state, [key]: !open }))} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  {open ? <ChevronDown className="size-4 text-ink-faint" /> : <ChevronRight className="size-4 text-ink-faint" />}
                  <span className="font-display text-[13px] font-semibold">{groupLabel(key)}</span>
                  <span className="text-[11px] text-ink-faint">
                    {skills.length} · {skills.length - disabledInGroup} activé{skills.length - disabledInGroup > 1 ? 's' : ''}
                  </span>
                </button>
                <Button size="sm" variant="ghost" disabled={disabled || disabledInGroup === 0} onClick={() => void onChange(skills.filter((skill) => !skill.enabled).map((skill) => ({ kind: 'skill', key: skill.name, enabled: true })))}>
                  Tout activer
                </Button>
                <Button size="sm" variant="ghost" disabled={disabled || disabledInGroup === skills.length} onClick={() => void onChange(skills.filter((skill) => skill.enabled).map((skill) => ({ kind: 'skill', key: skill.name, enabled: false })))}>
                  Tout désactiver
                </Button>
              </header>
              {open && (
                <div className="divide-y divide-line border-t border-line">
                  {skills.map((skill) => (
                    <div key={skill.name} className="flex items-start gap-3 px-4 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[12.5px] text-ink">/{skill.name}</div>
                        {skill.description && <div className="line-clamp-2 text-[12px] text-ink-muted">{skill.description}</div>}
                      </div>
                      <Switch checked={skill.enabled} disabled={disabled} label={`${skill.enabled ? 'Désactiver' : 'Activer'} ${skill.name}`} onChange={(enabled) => void onChange([{ kind: 'skill', key: skill.name, enabled }])} />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}
