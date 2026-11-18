/**
 * Every panel Aether can show: the terminal, and the panels of the enabled Aether mods.
 */
import { Blocks, Bot, Compass, FileCode2, FileDiff, GitBranch, SquareTerminal } from 'lucide-react'
import { BRANCH_PANEL_ID, BranchPanel } from '../components/BranchPanel'
import { CHANGES_PANEL_ID, ChangesPanel, FILE_PANEL_ID, FileViewerPanel } from '../components/ChangesPanel'
import { useMemo } from 'react'
import { modPanelId } from '../../../shared/aetherMods'
import { CHATGPT_PANEL_ID, ChatGptPanel } from '../components/ChatGptPanel'
import { registerPanelDefaults } from './layoutStore'
import { PILOT_PANEL_ID, PilotPanel } from '../pilot/PilotPanel'

registerPanelDefaults(CHATGPT_PANEL_ID, { position: 'right', floating: { width: 520, height: 680 } })
registerPanelDefaults(PILOT_PANEL_ID, { position: 'right', floating: { width: 460, height: 640 } })
registerPanelDefaults(CHANGES_PANEL_ID, { position: 'right', floating: { width: 620, height: 640 } })
registerPanelDefaults(FILE_PANEL_ID, { position: 'right', floating: { width: 620, height: 640 } })
registerPanelDefaults(BRANCH_PANEL_ID, { position: 'right', floating: { width: 440, height: 560 } })
import { TERMINAL_PANEL_ID, TerminalPanel } from '../components/TerminalDock'
import { ModPanelFrame } from '../mods/ModPanelFrame'
import { useModsStore } from '../mods/modsStore'
import type { PanelDefinition } from './DockLayout'

export function usePanelDefinitions(): Map<string, PanelDefinition> {
  const catalog = useModsStore((state) => state.catalog)
  return useMemo(() => {
    const definitions = new Map<string, PanelDefinition>()
    definitions.set(TERMINAL_PANEL_ID, { id: TERMINAL_PANEL_ID, title: 'Terminal', icon: <SquareTerminal />, render: () => <TerminalPanel /> })
    definitions.set(CHATGPT_PANEL_ID, { id: CHATGPT_PANEL_ID, title: 'ChatGPT', icon: <Bot />, render: () => <ChatGptPanel /> })
    definitions.set(PILOT_PANEL_ID, { id: PILOT_PANEL_ID, title: 'Pilote Codex', icon: <Compass />, render: () => <PilotPanel /> })
    definitions.set(CHANGES_PANEL_ID, { id: CHANGES_PANEL_ID, title: 'Modifications', icon: <FileDiff />, render: () => <ChangesPanel /> })
    definitions.set(FILE_PANEL_ID, { id: FILE_PANEL_ID, title: 'Fichier', icon: <FileCode2 />, render: () => <FileViewerPanel /> })
    definitions.set(BRANCH_PANEL_ID, { id: BRANCH_PANEL_ID, title: 'Branche et PR', icon: <GitBranch />, render: () => <BranchPanel /> })
    for (const mod of catalog?.mods ?? []) {
      if (!mod.enabled) continue
      for (const panel of mod.manifest.panels) {
        // Embedded panels live in their part of Aether, not in the dock.
        if (panel.embed) continue
        const id = modPanelId(mod.manifest.id, panel.id)
        definitions.set(id, { id, title: panel.title, icon: <Blocks />, render: () => <ModPanelFrame mod={mod} panelId={panel.id} /> })
      }
    }
    return definitions
  }, [catalog])
}
