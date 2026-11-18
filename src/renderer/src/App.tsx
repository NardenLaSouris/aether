import { useEffect, useState } from 'react'
import { usePilotStore } from './pilot/pilotStore'
import { NavigationRail, TitleBar, ToastStack, Logo } from './components/chrome'
import { PermissionDialog } from './components/workspace'
import { useTerminalDock, useTerminalInitialisation } from './components/TerminalDock'
import { DockLayout } from './layout/DockLayout'
import { useLayoutStore } from './layout/layoutStore'
import { usePanelDefinitions } from './layout/panels'
import { useModsStore } from './mods/modsStore'
import { ExtensionsPage } from './pages/ExtensionsPage'
import { ConfirmHost, ContextMenuHost, PromptHost, Spinner } from './components/ui'
import { api, errorMessage } from './lib/api'
import { ModPage } from './mods/EmbeddedModPanels'
import { ConversationsPage } from './pages/ConversationsPage'
import { HomePage } from './pages/HomePage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { UsagePage } from './pages/UsagePage'
import { useAppStore } from './stores/appStore'

export function App() {
  const ready = useAppStore((state) => state.ready)
  const page = useAppStore((state) => state.page)
  const theme = useAppStore((state) => state.preferences?.theme ?? 'forest')
  const initialise = useAppStore((state) => state.initialise)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const panelDefinitions = usePanelDefinitions()
  useTerminalInitialisation()

  useEffect(() => {
    initialise().catch((error: unknown) => setFatalError(errorMessage(error)))
  }, [initialise])

  // Once the preferences are known: restore where the panels were, and read the Aether mods.
  useEffect(() => {
    if (!ready) return
    useLayoutStore.getState().load(useAppStore.getState().preferences?.panelLayout)
    void useModsStore.getState().load()
    void usePilotStore.getState().load()
  }, [ready])

  // A user mod edited on disk: its panels reload by themselves.
  useEffect(() => api.on('mods:changed', ({ folder }) => void useModsStore.getState().filesChanged(folder)), [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'charcoal' ? 'charcoal' : 'forest'
  }, [theme])

  // Ctrl+` (Ctrl+² on AZERTY: same physical key) shows or hides the integrated terminal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && event.code === 'Backquote') {
        event.preventDefault()
        useTerminalDock.getState().toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (!ready) {
    return (
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Logo size={48} />
          {fatalError ? <div className="max-w-lg text-center text-sm text-danger">Initialisation impossible : {fatalError}</div> : <Spinner />}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <NavigationRail />
        <DockLayout definitions={panelDefinitions}>
          {page === 'home' && <HomePage />}
          {page === 'conversations' && <ConversationsPage />}
          {page === 'projects' && <ProjectsPage />}
          {page === 'sessions' && <SessionsPage />}
          {page === 'usage' && <UsagePage />}
          {page === 'extensions' && <ExtensionsPage />}
          {page === 'settings' && <SettingsPage />}
          {page.startsWith('mod:') && <ModPage pageId={page} />}
        </DockLayout>
      </div>
      <PermissionDialog />
      <ConfirmHost />
      <PromptHost />
      <ContextMenuHost />
      <ToastStack />
    </div>
  )
}
