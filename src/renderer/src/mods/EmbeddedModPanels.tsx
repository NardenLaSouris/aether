/**
 * Mod panels drawn inside a part of Aether (declared with `embed` in their manifest), always visible there:
 * strips under the list of conversations or above the message box, and whole pages in the left rail.
 */
import { DEFAULT_EMBED_HEIGHT, embeddedPanels, modPanelId, parseModPanelId, type ModPanelEmbed } from '../../../shared/aetherMods'
import { Blocks } from 'lucide-react'
import { EmptyState } from '../components/ui'
import { ModPanelFrame } from './ModPanelFrame'
import { useModsStore } from './modsStore'

export function EmbeddedModPanels({ embed, className }: { embed: Exclude<ModPanelEmbed, 'page'>; className?: string }) {
  const catalog = useModsStore((state) => state.catalog)
  const panels = embeddedPanels(catalog?.mods ?? [], embed)
  if (panels.length === 0) return null
  return (
    <div className={className ?? 'shrink-0 border-t border-line'}>
      {panels.map(({ mod, panel }) => (
        <div key={modPanelId(mod.manifest.id, panel.id)} className="overflow-hidden border-b border-line last:border-b-0" style={{ height: panel.embedHeight ?? DEFAULT_EMBED_HEIGHT[embed] }}>
          <ModPanelFrame mod={mod} panelId={panel.id} />
        </div>
      ))}
    </div>
  )
}

/** A mod panel shown as a page (`embed: "page"`), at `mod:<mod id>:<panel id>`. */
export function ModPage({ pageId }: { pageId: string }) {
  const catalog = useModsStore((state) => state.catalog)
  const target = parseModPanelId(pageId)
  const found = target ? embeddedPanels(catalog?.mods ?? [], 'page').find(({ mod, panel }) => mod.manifest.id === target.modId && panel.id === target.panelId) : undefined
  if (!found) return <EmptyState icon={<Blocks className="size-5" />} title="Page de mod indisponible" description="Ce mod est désactivé ou n’existe plus. Voir Extensions › Mods Aether." />
  return (
    <div className="h-full min-h-0">
      <ModPanelFrame mod={found.mod} panelId={found.panel.id} />
    </div>
  )
}
