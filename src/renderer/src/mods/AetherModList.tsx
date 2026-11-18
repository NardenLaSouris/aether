/**
 * Aether mods: switch them on or off, open their panels, find the folder where to install new ones.
 */
import { Blocks, FolderOpen, PanelTop, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { MOD_PERMISSIONS, modPanelId } from '../../../shared/aetherMods'
import { Badge, Button, confirmAction, EmptyState, Switch } from '../components/ui'
import { useLayoutStore } from '../layout/layoutStore'
import { useModsStore } from './modsStore'
import { useAppStore } from '../stores/appStore'

export function AetherModList() {
  const catalog = useModsStore((state) => state.catalog)
  const loading = useModsStore((state) => state.loading)
  const load = useModsStore((state) => state.load)
  const setEnabled = useModsStore((state) => state.setEnabled)
  const openFolder = useModsStore((state) => state.openFolder)
  const openPanel = useLayoutStore((state) => state.open)

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (modId: string, enabled: boolean, source: 'builtin' | 'user', permissions: string[]) => {
    if (enabled && source === 'user') {
      const confirmed = await confirmAction({
        title: 'Activer ce mod ?',
        message: (
          <div className="space-y-2">
            <p>Ce mod a été installé à la main dans le dossier des mods. Il s’exécute dans un cadre isolé, sans accès au réseau ni à vos fichiers, avec seulement ces permissions :</p>
            <ul className="list-disc pl-5">{permissions.length ? permissions.map((permission) => <li key={permission}>{MOD_PERMISSIONS[permission as keyof typeof MOD_PERMISSIONS] ?? permission}</li>) : <li>aucune</li>}</ul>
            <p>N’activez que des mods dont vous connaissez la provenance.</p>
          </div>
        ),
        confirmLabel: 'Activer'
      })
      if (!confirmed) return
    }
    await setEnabled(modId, enabled)
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <p className="max-w-3xl flex-1 text-[13px] text-ink-muted">
          Les mods Aether ajoutent des panneaux à l’interface et des commandes <span className="font-mono">/…</span> à la zone de saisie (elles ouvrent le panneau, rien n’est envoyé à Claude). Chaque panneau tourne dans un cadre isolé, sans réseau, avec les seules permissions déclarées. Pour en installer un, placez son dossier (avec <span className="font-mono">aether-mod.json</span>) dans le dossier des mods.
        </p>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} disabled={loading} onClick={() => void load()}>
          Actualiser
        </Button>
        <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => void openFolder()}>
          Dossier des mods
        </Button>
      </div>

      {catalog && catalog.errors.length > 0 && (
        <div className="mb-3 rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-[12.5px] text-warning">
          {catalog.errors.map((error) => (
            <div key={error.directoryPath} className="selectable">
              <span className="font-mono">{error.directoryPath}</span> : {error.error}
            </div>
          ))}
        </div>
      )}

      {!catalog || catalog.mods.length === 0 ? (
        <EmptyState icon={<Blocks className="size-5" />} title="Aucun mod Aether" description="Placez un dossier de mod dans le dossier des mods, puis actualisez." />
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line bg-panel">
          {catalog.mods.map((mod) => (
            <div key={mod.manifest.id} className="flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-[13.5px] font-semibold">{mod.manifest.name}</span>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {mod.manifest.id} · {mod.manifest.version}
                  </span>
                  <Badge tone={mod.source === 'builtin' ? 'sage' : 'neutral'}>{mod.source === 'builtin' ? 'intégré' : 'installé'}</Badge>
                  {mod.manifest.commands.map((command) => (
                    <Badge key={command.name} tone="gold">
                      /{command.name}
                    </Badge>
                  ))}
                </div>
                {mod.manifest.description && <div className="mt-1 text-[12.5px] text-ink-muted">{mod.manifest.description}</div>}
                <div className="mt-1 text-[11.5px] text-ink-faint">Permissions : {mod.manifest.permissions.length ? mod.manifest.permissions.map((permission) => MOD_PERMISSIONS[permission]).join(' · ') : 'aucune'}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                {mod.enabled &&
                  mod.manifest.panels.map((panel) =>
                    panel.embed === 'page' ? (
                      <Button key={panel.id} size="sm" variant="subtle" icon={<PanelTop className="size-3.5" />} onClick={() => useAppStore.getState().navigate(`mod:${mod.manifest.id}:${panel.id}`)}>
                        {panel.title}
                      </Button>
                    ) : panel.embed ? (
                      <Badge key={panel.id}>{panel.embed === 'composer-top' ? 'Au-dessus de la saisie' : 'Sous la liste des conversations'}</Badge>
                    ) : (
                      <Button key={panel.id} size="sm" variant="subtle" icon={<PanelTop className="size-3.5" />} onClick={() => openPanel(modPanelId(mod.manifest.id, panel.id))}>
                        {panel.title}
                      </Button>
                    )
                  )}
                <Switch checked={mod.enabled} label={`${mod.enabled ? 'Désactiver' : 'Activer'} ${mod.manifest.name}`} onChange={(checked) => void toggle(mod.manifest.id, checked, mod.source, mod.manifest.permissions)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
