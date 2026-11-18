/**
 * Integrated terminal: real shells (PowerShell, cmd, Git Bash…) in a movable panel
 * (docked left, right, bottom or floating). Terminals keep running while the panel is hidden.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { TerminalInfo, TerminalShellId, TerminalShellOption } from '../../../shared/domain'
import { isPanelVisible } from '../../../shared/panelLayout'
import { registerPanelDefaults, useLayoutStore } from '../layout/layoutStore'
import { api, errorMessage } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { classNames, IconButton } from './ui'

export const TERMINAL_PANEL_ID = 'terminal'
registerPanelDefaults(TERMINAL_PANEL_ID, { position: 'bottom', floating: { width: 680, height: 380 } })

interface TerminalDockState {
  terminals: TerminalInfo[]
  activeTerminalId: string | null
  shells: TerminalShellOption[]
  initialised: boolean
  /** Shows or hides the terminal panel (wherever it is placed). */
  toggle(): void
  create(options: { shell?: TerminalShellId; workingDirectory?: string }): Promise<void>
  close(terminalId: string): Promise<void>
  select(terminalId: string): void
  markExited(terminalId: string, exitCode: number): void
  initialise(): Promise<void>
}

/** Output that arrives before a terminal view has mounted. */
const earlyOutput = new Map<string, string>()
const outputListeners = new Map<string, (data: string) => void>()
let pushSubscribed = false

function subscribeToTerminalPushes(): void {
  if (pushSubscribed) return
  pushSubscribed = true
  api.on('terminal:data', ({ terminalId, data }) => {
    const listener = outputListeners.get(terminalId)
    if (listener) listener(data)
    else earlyOutput.set(terminalId, (earlyOutput.get(terminalId) ?? '') + data)
  })
  api.on('terminal:exit', ({ terminalId, exitCode }) => useTerminalDock.getState().markExited(terminalId, exitCode))
}

let creating = false

export const useTerminalDock = create<TerminalDockState>((set, get) => ({
  terminals: [],
  activeTerminalId: null,
  shells: [],
  initialised: false,
  toggle() {
    useLayoutStore.getState().toggle(TERMINAL_PANEL_ID)
  },
  async create({ shell, workingDirectory }) {
    if (creating) return
    creating = true
    try {
      const info = await api.invoke('terminal:create', { ...(shell ? { shell } : {}), ...(workingDirectory ? { workingDirectory } : {}), columns: 100, rows: 24 })
      set((state) => ({ terminals: [...state.terminals, info], activeTerminalId: info.terminalId }))
      useLayoutStore.getState().open(TERMINAL_PANEL_ID)
    } catch (error) {
      useAppStore.getState().toast({ tone: 'error', title: 'Terminal impossible à ouvrir', body: errorMessage(error) })
    } finally {
      creating = false
    }
  },
  async close(terminalId) {
    await api.invoke('terminal:close', { terminalId }).catch(() => undefined)
    outputListeners.delete(terminalId)
    earlyOutput.delete(terminalId)
    set((state) => {
      const terminals = state.terminals.filter((terminal) => terminal.terminalId !== terminalId)
      const activeTerminalId = state.activeTerminalId === terminalId ? (terminals.at(-1)?.terminalId ?? null) : state.activeTerminalId
      return { terminals, activeTerminalId }
    })
    if (get().terminals.length === 0) useLayoutStore.getState().close(TERMINAL_PANEL_ID)
  },
  select(terminalId) {
    set({ activeTerminalId: terminalId })
  },
  markExited(terminalId, exitCode) {
    set((state) => ({ terminals: state.terminals.map((terminal) => (terminal.terminalId === terminalId ? { ...terminal, exited: true, exitCode } : terminal)) }))
  },
  async initialise() {
    subscribeToTerminalPushes()
    const [shells, existing] = await Promise.all([api.invoke('terminal:shells'), api.invoke('terminal:list')])
    // After a window reload, terminals still running in the main process are re-attached with their output.
    for (const terminal of existing) {
      const scrollback = await api.invoke('terminal:scrollback', { terminalId: terminal.terminalId }).catch(() => '')
      if (scrollback) earlyOutput.set(terminal.terminalId, scrollback + (earlyOutput.get(terminal.terminalId) ?? ''))
    }
    set({ shells, terminals: existing, activeTerminalId: existing.at(-1)?.terminalId ?? null, initialised: true })
  }
}))

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

const TERMINAL_THEME = {
  background: '#121513',
  foreground: '#E9E3D6',
  cursor: '#C4A96A',
  cursorAccent: '#121513',
  selectionBackground: 'rgba(196, 169, 106, 0.35)',
  black: '#1A1C1B',
  red: '#E07A6B',
  green: '#86A18B',
  yellow: '#C4A96A',
  blue: '#7FA6C9',
  magenta: '#B897C7',
  cyan: '#7DB8AE',
  white: '#E9E3D6',
  brightBlack: '#5D645F',
  brightRed: '#F0968A',
  brightGreen: '#A6C2AA',
  brightYellow: '#E3CD95',
  brightBlue: '#9DC0E0',
  brightMagenta: '#D2B3E0',
  brightCyan: '#9DD3C9',
  brightWhite: '#F4EFE4'
}

function TerminalView({ terminal, visible }: { terminal: TerminalInfo; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const xtermRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const xterm = new Terminal({ fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, allowProposedApi: false, theme: TERMINAL_THEME })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(container)
    xtermRef.current = xterm
    fitRef.current = fit

    const pending = earlyOutput.get(terminal.terminalId)
    if (pending) xterm.write(pending)
    earlyOutput.delete(terminal.terminalId)
    outputListeners.set(terminal.terminalId, (data) => xterm.write(data))

    // Ctrl+C copies when text is selected (otherwise it interrupts, as in any terminal); Ctrl+V pastes.
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey) return true
      const key = event.key.toLowerCase()
      if (key === 'c' && xterm.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection()).catch(() => undefined)
        xterm.clearSelection()
        return false
      }
      if (key === 'v') return false // let the browser fire a paste event, which xterm handles
      return true
    })
    const input = xterm.onData((data) => void api.invoke('terminal:write', { terminalId: terminal.terminalId, data }).catch(() => undefined))
    let resizeTimer: number | undefined
    const resize = xterm.onResize(({ cols, rows }) => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => void api.invoke('terminal:resize', { terminalId: terminal.terminalId, columns: cols, rows }).catch(() => undefined), 60)
    })
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) fit.fit()
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      input.dispose()
      resize.dispose()
      window.clearTimeout(resizeTimer)
      outputListeners.delete(terminal.terminalId)
      xterm.dispose()
      xtermRef.current = null
    }
  }, [terminal.terminalId])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit()
      xtermRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return <div ref={containerRef} data-terminal-id={terminal.terminalId} className={classNames('aether-terminal absolute inset-0 px-2 pt-1.5', visible ? 'visible' : 'invisible')} />
}

function NewTerminalMenu({ onClose }: { onClose: () => void }) {
  const shells = useTerminalDock((state) => state.shells)
  const createTerminal = useTerminalDock((state) => state.create)
  const projects = useAppStore((state) => state.projects)
  const conversation = useAppStore((state) => state.conversations.find((item) => item.id === state.activeConversationId) ?? null)
  const preferredShell = useAppStore((state) => state.preferences?.terminalShell ?? 'powershell')
  const [shell, setShell] = useState<TerminalShellId>(preferredShell)
  const folders = [
    ...(conversation ? [{ label: `Conversation : ${folderName(conversation.workingDirectory)}`, path: conversation.workingDirectory }] : []),
    ...projects.map((project) => ({ label: `Projet : ${project.name}`, path: project.directoryPath })),
    { label: 'Dossier par défaut', path: '' }
  ]
  return (
    <div className="absolute top-full right-0 z-30 mt-1 w-72 rounded-lg border border-line-strong bg-[#212523] p-2 shadow-pop" role="dialog" aria-label="Nouveau terminal">
      <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Shell</div>
      <div className="mb-2 flex flex-wrap gap-1">
        {shells.map((option) => (
          <button key={option.id} type="button" onClick={() => setShell(option.id)} className={classNames('rounded border px-2 py-1 text-[12px]', shell === option.id ? 'border-gold/50 bg-accent-soft text-gold' : 'border-line text-ink-muted hover:text-ink')}>
            {option.label}
          </button>
        ))}
      </div>
      <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Ouvrir dans</div>
      <div className="flex max-h-56 flex-col overflow-y-auto">
        {folders.map((folder) => (
          <button
            key={`${folder.label}-${folder.path}`}
            type="button"
            className="truncate rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-white/6"
            title={folder.path || undefined}
            onClick={() => {
              onClose()
              void createTerminal({ shell, ...(folder.path ? { workingDirectory: folder.path } : {}) })
            }}
          >
            {folder.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Loads the running terminals once at startup (they survive a window reload). */
export function useTerminalInitialisation(): void {
  const initialise = useTerminalDock((state) => state.initialise)
  useEffect(() => {
    void initialise().catch(() => undefined)
  }, [initialise])
}

/** Body of the "Terminal" panel: shell tabs and the terminal screens. Placed by the dock layout. */
export function TerminalPanel() {
  const visible = useLayoutStore((state) => isPanelVisible(state.layout, TERMINAL_PANEL_ID))
  const terminals = useTerminalDock((state) => state.terminals)
  const activeTerminalId = useTerminalDock((state) => state.activeTerminalId)
  const initialised = useTerminalDock((state) => state.initialised)
  const createTerminal = useTerminalDock((state) => state.create)
  const closeTerminal = useTerminalDock((state) => state.close)
  const select = useTerminalDock((state) => state.select)
  const conversation = useAppStore((state) => (state.page === 'conversations' ? (state.conversations.find((item) => item.id === state.activeConversationId) ?? null) : null))
  const [menuOpen, setMenuOpen] = useState(false)

  // Showing an empty terminal panel starts a shell.
  useEffect(() => {
    if (visible && initialised && terminals.length === 0) void createTerminal(conversation ? { workingDirectory: conversation.workingDirectory } : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the panel is shown
  }, [visible, initialised])

  return (
    <div aria-label="Terminal intégré" className="flex h-full flex-col bg-[#121513]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {terminals.map((terminal) => (
            <div key={terminal.terminalId} className={classNames('group flex shrink-0 items-center rounded-md border text-[12px]', terminal.terminalId === activeTerminalId ? 'border-gold/40 bg-black/30 text-ink' : 'border-transparent text-ink-muted hover:bg-white/5')}>
              <button type="button" role="tab" aria-selected={terminal.terminalId === activeTerminalId} title={terminal.workingDirectory} onClick={() => select(terminal.terminalId)} className="flex items-center gap-1.5 py-1 pr-1 pl-2.5">
                <span>{terminal.label}</span>
                <span className="text-ink-faint">· {folderName(terminal.workingDirectory)}</span>
                {terminal.exited && <span className="text-warning">(terminé{terminal.exitCode !== null ? ` · ${terminal.exitCode}` : ''})</span>}
              </button>
              <button type="button" aria-label={`Fermer le terminal ${terminal.label}`} onClick={() => void closeTerminal(terminal.terminalId)} className="mr-1 rounded p-0.5 text-ink-faint opacity-60 group-hover:opacity-100 hover:bg-white/10 hover:text-ink">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="relative flex items-center">
          <IconButton label={conversation ? 'Nouveau terminal dans le dossier de la conversation' : 'Nouveau terminal'} onClick={() => void createTerminal(conversation ? { workingDirectory: conversation.workingDirectory } : {})}>
            <Plus className="size-4" />
          </IconButton>
          <IconButton label="Choisir le shell et le dossier" active={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
            <ChevronDown className="size-4" />
          </IconButton>
          {menuOpen && <NewTerminalMenu onClose={() => setMenuOpen(false)} />}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {terminals.map((terminal) => (
          <TerminalView key={terminal.terminalId} terminal={terminal} visible={visible && terminal.terminalId === activeTerminalId} />
        ))}
      </div>
    </div>
  )
}
