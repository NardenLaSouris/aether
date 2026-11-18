/**
 * Aether mods as the interface sees them: the catalogue, the slash commands they declare, and the
 * version of each mod's files (bumped when they change on disk, so open panels reload by themselves).
 */
import { create } from 'zustand'
import { findModCommand, modPanelDefaults, modPanelId, type AetherModCatalog } from '../../../shared/aetherMods'
import { registerPanelDefaults, useLayoutStore } from '../layout/layoutStore'
import { api, errorMessage } from '../lib/api'
import { useAppStore } from '../stores/appStore'

interface ModsState {
  catalog: AetherModCatalog | null
  loading: boolean
  /** Mod id → number of reloads of its files since Aether started. */
  versions: Record<string, number>
  load(): Promise<void>
  setEnabled(modId: string, enabled: boolean): Promise<void>
  openFolder(): Promise<void>
  /** A user mod folder changed on disk (null: the mods folder itself): re-reads the catalogue and reloads its panels. */
  filesChanged(folder: string | null): Promise<void>
  /** Runs `/command` if an enabled mod declares it; returns false for anything else (sent to Claude). */
  runCommand(text: string): boolean
}

function registerDefaults(catalog: AetherModCatalog): void {
  for (const mod of catalog.mods) {
    for (const panel of mod.manifest.panels) if (!panel.embed) registerPanelDefaults(modPanelId(mod.manifest.id, panel.id), modPanelDefaults(panel))
  }
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? ''
}

export const useModsStore = create<ModsState>((set, get) => ({
  catalog: null,
  loading: false,
  versions: {},
  async load() {
    set({ loading: true })
    try {
      const catalog = await api.invoke('mods:catalog')
      registerDefaults(catalog)
      set({ catalog })
    } catch (error) {
      useAppStore.getState().toast({ tone: 'error', title: 'Mods Aether illisibles', body: errorMessage(error) })
    } finally {
      set({ loading: false })
    }
  },
  async setEnabled(modId, enabled) {
    try {
      const catalog = await api.invoke('mods:set-enabled', { modId, enabled })
      registerDefaults(catalog)
      set({ catalog })
      if (!enabled) {
        const mod = catalog.mods.find((item) => item.manifest.id === modId)
        for (const panel of mod?.manifest.panels ?? []) useLayoutStore.getState().close(modPanelId(modId, panel.id))
        const page = useAppStore.getState().page
        if (page.startsWith(`mod:${modId}:`)) useAppStore.getState().navigate('extensions')
      }
    } catch (error) {
      useAppStore.getState().toast({ tone: 'error', title: 'Changement non appliqué', body: errorMessage(error) })
    }
  },
  async openFolder() {
    await api.invoke('mods:open-folder').catch((error: unknown) => useAppStore.getState().toast({ tone: 'error', title: 'Dossier des mods', body: errorMessage(error) }))
  },
  async filesChanged(folder) {
    await get().load()
    const mods = get().catalog?.mods ?? []
    const changed = mods.filter((mod) => mod.source === 'user' && (folder === null || folderName(mod.directoryPath) === folder.toLowerCase()))
    if (changed.length === 0) return
    const versions = { ...get().versions }
    for (const mod of changed) versions[mod.manifest.id] = (versions[mod.manifest.id] ?? 0) + 1
    set({ versions })
  },
  runCommand(text) {
    const found = findModCommand(text, get().catalog?.mods ?? [])
    if (!found) return false
    const panel = found.mod.manifest.panels.find((item) => item.id === found.command.opensPanel)
    if (panel?.embed === 'page') {
      useAppStore.getState().navigate(`mod:${found.mod.manifest.id}:${panel.id}`)
      return true
    }
    const panelId = modPanelId(found.mod.manifest.id, found.command.opensPanel)
    const layout = useLayoutStore.getState()
    layout.open(panelId)
    layout.focus(panelId)
    return true
  }
}))
