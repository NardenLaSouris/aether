/**
 * Application chrome: custom title bar, navigation sidebar, toasts.
 */
import { BarChart3, Blocks, Bot, Copy, FolderKanban, History, Home, MessagesSquare, Minus, Puzzle, Settings, Square, SquareTerminal, X, CheckCircle2, AlertTriangle, Info, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import logoUrl from '../assets/logo.png'
import { api } from '../lib/api'
import { CHATGPT_PANEL_ID } from './ChatGptPanel'
import { useAppStore, type PageId } from '../stores/appStore'
import { isPanelVisible } from '../../../shared/panelLayout'
import { useLayoutStore } from '../layout/layoutStore'
import { TERMINAL_PANEL_ID, useTerminalDock } from './TerminalDock'
import { useModsStore } from '../mods/modsStore'
import { embeddedPanels } from '../../../shared/aetherMods'
import { classNames, Tooltip } from './ui'

export function Logo({ size = 22 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden="true" draggable={false} className="shrink-0 select-none" />
}

function ConnectionIndicator() {
  const installation = useAppStore((state) => state.installation)
  const auth = useAppStore((state) => state.auth)
  let tone: 'ok' | 'warn' | 'error' | 'pending' = 'pending'
  let label = 'Vérification…'
  if (installation && !installation.found) {
    tone = 'error'
    label = 'Claude Code introuvable'
  } else if (auth?.checked && !auth.loggedIn) {
    tone = 'warn'
    label = 'Non connecté'
  } else if (auth?.loggedIn) {
    tone = 'ok'
    label = auth.email ? `Connecté · ${auth.email}` : 'Connecté'
  }
  const colors = { ok: 'bg-success', warn: 'bg-warning', error: 'bg-danger', pending: 'bg-ink-faint animate-pulse-soft' }
  return (
    <Tooltip content={installation?.version ? `Claude Code ${installation.version}` : label}>
      <span className="no-drag flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-muted">
        <span className={classNames('size-1.5 rounded-full', colors[tone])} />
        {label}
      </span>
    </Tooltip>
  )
}

function EngineActivityIndicator() {
  const engine = useAppStore((state) => state.engine)
  const busy = engine.busyRunners > 0
  const labels: Record<string, string> = { stopped: 'Moteur arrêté', starting: 'Démarrage du moteur', running: busy ? `${engine.busyRunners} génération${engine.busyRunners > 1 ? 's' : ''} en cours` : 'Moteur prêt', restarting: 'Redémarrage du moteur', crashed: 'Moteur interrompu', failed: 'Moteur en échec' }
  const failing = engine.hostState === 'crashed' || engine.hostState === 'failed'
  return (
    <Tooltip content={engine.lastError ?? `${engine.activeRunners} session(s) active(s)`}>
      <span className={classNames('no-drag flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]', failing ? 'border-danger/40 text-danger' : busy ? 'border-gold/40 text-gold' : 'border-line text-ink-muted')}>
        <span className={classNames('size-1.5 rounded-full', failing ? 'bg-danger' : busy ? 'animate-pulse-soft bg-gold' : engine.hostState === 'running' ? 'bg-sage' : 'bg-ink-faint')} />
        {labels[engine.hostState] ?? engine.hostState}
      </span>
    </Tooltip>
  )
}

export function TitleBar() {
  const appName = useAppStore((state) => state.appName)
  const maximized = useAppStore((state) => state.windowMaximized)
  return (
    <header className="drag-region flex h-10 shrink-0 items-center justify-between border-b border-black/30 bg-forest-night pl-3">
      <div className="flex items-center gap-2.5">
        <Logo size={20} />
        <span className="font-display text-[13px] font-semibold tracking-[0.14em] text-cream uppercase">{appName}</span>
      </div>
      <div className="flex items-center gap-2">
        <EngineActivityIndicator />
        <ConnectionIndicator />
        <div className="ml-2 flex h-10">
          <button type="button" aria-label="Réduire" className="no-drag flex w-11 items-center justify-center text-ink-muted hover:bg-white/8" onClick={() => void api.invoke('window:minimize')}>
            <Minus className="size-3.5" />
          </button>
          <button type="button" aria-label={maximized ? 'Restaurer' : 'Agrandir'} className="no-drag flex w-11 items-center justify-center text-ink-muted hover:bg-white/8" onClick={() => void api.invoke('window:toggle-maximize')}>
            {maximized ? <Copy className="size-3 -scale-x-100" /> : <Square className="size-3" />}
          </button>
          <button type="button" aria-label="Fermer" className="no-drag flex w-11 items-center justify-center text-ink-muted hover:bg-[#c4473a] hover:text-white" onClick={() => void api.invoke('window:close')}>
            <X className="size-4" />
          </button>
        </div>
      </div>
    </header>
  )
}

const NAVIGATION: { page: PageId; label: string; icon: ReactNode }[] = [
  { page: 'home', label: 'Accueil', icon: <Home className="size-[18px]" /> },
  { page: 'conversations', label: 'Conversations', icon: <MessagesSquare className="size-[18px]" /> },
  { page: 'projects', label: 'Projets', icon: <FolderKanban className="size-[18px]" /> },
  { page: 'sessions', label: 'Sessions Claude Code', icon: <History className="size-[18px]" /> },
  { page: 'usage', label: 'Consommation', icon: <BarChart3 className="size-[18px]" /> },
  { page: 'extensions', label: 'Extensions (plugins, mods, skills)', icon: <Puzzle className="size-[18px]" /> }
]

function TerminalToggle() {
  const open = useLayoutStore((state) => isPanelVisible(state.layout, TERMINAL_PANEL_ID))
  const count = useTerminalDock((state) => state.terminals.length)
  const toggle = useTerminalDock((state) => state.toggle)
  return (
    <Tooltip content={`${open ? 'Masquer' : 'Afficher'} le terminal (Ctrl+\`)`} side="right">
      <button type="button" aria-label="Terminal" aria-pressed={open} onClick={toggle} className={classNames('relative flex size-10 items-center justify-center rounded-lg transition-colors', open ? 'bg-black/25 text-gold shadow-[inset_0_0_0_1px_rgba(196,169,106,0.35)]' : 'text-cream/65 hover:bg-black/15 hover:text-cream')}>
        <SquareTerminal className="size-[18px]" />
        {count > 0 && !open && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-sage" />}
      </button>
    </Tooltip>
  )
}

/** Shows or hides the ChatGPT panel (chatgpt.com in an isolated session, movable like the terminal). */
function ChatGptToggle() {
  const open = useLayoutStore((state) => isPanelVisible(state.layout, CHATGPT_PANEL_ID))
  const toggle = useLayoutStore((state) => state.toggle)
  return (
    <Tooltip content={`${open ? 'Masquer' : 'Afficher'} ChatGPT (votre compte OpenAI, session isolée)`} side="right">
      <button type="button" aria-label="ChatGPT" aria-pressed={open} onClick={() => toggle(CHATGPT_PANEL_ID)} className={classNames('relative flex size-10 items-center justify-center rounded-lg transition-colors', open ? 'bg-black/25 text-gold shadow-[inset_0_0_0_1px_rgba(196,169,106,0.35)]' : 'text-cream/65 hover:bg-black/15 hover:text-cream')}>
        <Bot className="size-[18px]" />
      </button>
    </Tooltip>
  )
}

export function NavigationRail() {
  const page = useAppStore((state) => state.page)
  const navigate = useAppStore((state) => state.navigate)
  const pendingCount = useAppStore((state) => state.pendingPermissions.length)
  const blocked = useAppStore((state) => state.quota.block !== null)
  const catalog = useModsStore((state) => state.catalog)
  const modPages = embeddedPanels(catalog?.mods ?? [], 'page')
  const item =(target: PageId, label: string, icon: ReactNode, badge?: ReactNode) => (
    <Tooltip key={target} content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={page === target ? 'page' : undefined}
        onClick={() => navigate(target)}
        className={classNames('relative flex size-10 items-center justify-center rounded-lg transition-colors', page === target ? 'bg-black/25 text-gold shadow-[inset_0_0_0_1px_rgba(196,169,106,0.35)]' : 'text-cream/65 hover:bg-black/15 hover:text-cream')}
      >
        {icon}
        {badge}
      </button>
    </Tooltip>
  )
  return (
    <nav className="flex w-[60px] shrink-0 flex-col items-center gap-1.5 border-r border-black/25 bg-sidebar py-3">
      {NAVIGATION.map((entry) =>
        item(
          entry.page,
          entry.label,
          entry.icon,
          entry.page === 'conversations' && pendingCount > 0 ? <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-gold text-[10px] font-bold text-charcoal">{pendingCount}</span> : entry.page === 'usage' && blocked ? <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning" /> : undefined
        )
      )}
      {modPages.length > 0 && <div className="my-1 h-px w-7 bg-cream/10" aria-hidden="true" />}
      {modPages.map(({ mod, panel }) => item(`mod:${mod.manifest.id}:${panel.id}`, panel.title, <Blocks className="size-[18px]" />))}
      <div className="flex-1" />
      <ChatGptToggle />
      <TerminalToggle />
      {item('settings', 'Paramètres', <Settings className="size-[18px]" />)}
    </nav>
  )
}

export function ToastStack() {
  const toasts = useAppStore((state) => state.toasts)
  const dismiss = useAppStore((state) => state.dismissToast)
  const icons = { info: <Info className="size-4 text-info" />, success: <CheckCircle2 className="size-4 text-success" />, warning: <AlertTriangle className="size-4 text-warning" />, error: <XCircle className="size-4 text-danger" /> }
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[110] flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto flex animate-rise gap-3 rounded-lg border border-line-strong bg-[#212523] px-3.5 py-3 shadow-pop">
          <span className="mt-0.5">{icons[toast.tone]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{toast.title}</div>
            {toast.body && <div className="selectable mt-0.5 text-xs break-words text-ink-muted">{toast.body}</div>}
          </div>
          <button type="button" aria-label="Fermer la notification" className="self-start text-ink-faint hover:text-ink" onClick={() => dismiss(toast.id)}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
