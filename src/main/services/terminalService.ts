/**
 * Integrated terminals: real Windows pseudo-consoles (ConPTY through node-pty) running in the
 * user's own shell, in a folder they chose. Output is batched before it crosses IPC.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { TerminalInfo, TerminalShellId, TerminalShellOption } from '../../shared/domain'

export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(columns: number, rows: number): void
  kill(): void
}

export type PtySpawner = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyProcess

export interface TerminalServiceDependencies {
  spawn: PtySpawner
  onData: (terminalId: string, data: string) => void
  onExit: (terminalId: string, exitCode: number) => void
  environment?: NodeJS.ProcessEnv
  fileExists?: (path: string) => boolean
  setTimer?: (callback: () => void, delayMs: number) => unknown
}

export const MAX_TERMINALS = 8
const FLUSH_DELAY_MS = 8
const FLUSH_SIZE = 64 * 1024
const SCROLLBACK_LIMIT = 256 * 1024
/** Variables that would make tools started in the terminal believe they run inside Electron or Claude Code. */
const STRIPPED_VARIABLES = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_RENDERER_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AETHER_USER_DATA_DIR']

export function detectShells(environment: NodeJS.ProcessEnv = process.env, fileExists: (path: string) => boolean = existsSync): TerminalShellOption[] {
  const systemRoot = environment.SystemRoot ?? environment.windir ?? 'C:\\Windows'
  const programFiles = environment.ProgramFiles ?? 'C:\\Program Files'
  const fromPath = (executable: string): string | null => {
    for (const directory of (environment.Path ?? environment.PATH ?? '').split(delimiter)) {
      if (!directory) continue
      const candidate = join(directory, executable)
      if (fileExists(candidate)) return candidate
    }
    return null
  }
  const shells: TerminalShellOption[] = []
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (fileExists(powershell)) shells.push({ id: 'powershell', label: 'Windows PowerShell', executablePath: powershell })
  const pwsh = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')].find(fileExists) ?? fromPath('pwsh.exe')
  if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', executablePath: pwsh })
  const commandPrompt = environment.ComSpec ?? join(systemRoot, 'System32', 'cmd.exe')
  if (fileExists(commandPrompt)) shells.push({ id: 'cmd', label: 'Invite de commandes', executablePath: commandPrompt })
  const gitBash = [join(programFiles, 'Git', 'bin', 'bash.exe'), join(environment.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')].find((candidate) => candidate && fileExists(candidate))
  if (gitBash) shells.push({ id: 'git-bash', label: 'Git Bash', executablePath: gitBash })
  return shells
}

export function shellArguments(shell: TerminalShellId): string[] {
  if (shell === 'powershell' || shell === 'pwsh') return ['-NoLogo']
  if (shell === 'git-bash') return ['--login', '-i']
  return []
}

export function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && !STRIPPED_VARIABLES.includes(key)) environment[key] = value
  environment.TERM = 'xterm-256color'
  environment.COLORTERM = 'truecolor'
  environment.TERM_PROGRAM = 'Aether'
  return environment
}

interface TerminalRecord {
  info: TerminalInfo
  process: PtyProcess
  pending: string
  flushScheduled: boolean
  scrollback: string
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>()
  private shellsCache: TerminalShellOption[] | null = null

  constructor(private readonly dependencies: TerminalServiceDependencies) {}

  shells(): TerminalShellOption[] {
    this.shellsCache ??= detectShells(this.dependencies.environment ?? process.env, this.dependencies.fileExists ?? existsSync)
    return this.shellsCache
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((record) => ({ ...record.info }))
  }

  create(options: { shell: TerminalShellId; workingDirectory: string; columns: number; rows: number }): TerminalInfo {
    const running = [...this.terminals.values()].filter((record) => !record.info.exited).length
    if (running >= MAX_TERMINALS) throw new Error(`${MAX_TERMINALS} terminaux au maximum. Fermez-en un pour en ouvrir un autre.`)
    const shells = this.shells()
    const shell = shells.find((candidate) => candidate.id === options.shell) ?? shells[0]
    if (!shell) throw new Error('Aucun shell Windows trouvé (PowerShell, cmd).')
    const terminalId = randomUUID()
    const child = this.dependencies.spawn(shell.executablePath, shellArguments(shell.id), {
      name: 'xterm-256color',
      cols: options.columns,
      rows: options.rows,
      cwd: options.workingDirectory,
      env: terminalEnvironment(this.dependencies.environment ?? process.env)
    })
    const record: TerminalRecord = {
      info: { terminalId, shell: shell.id, label: shell.label, workingDirectory: options.workingDirectory, pid: child.pid, createdAt: Date.now(), exited: false, exitCode: null },
      process: child,
      pending: '',
      flushScheduled: false,
      scrollback: ''
    }
    this.terminals.set(terminalId, record)
    child.onData((data) => this.buffer(record, data))
    child.onExit(({ exitCode }) => {
      this.flush(record)
      record.info.exited = true
      record.info.exitCode = exitCode
      this.dependencies.onExit(terminalId, exitCode)
    })
    return { ...record.info }
  }

  private buffer(record: TerminalRecord, data: string): void {
    record.pending += data
    record.scrollback = (record.scrollback + data).slice(-SCROLLBACK_LIMIT)
    if (record.pending.length >= FLUSH_SIZE) {
      this.flush(record)
      return
    }
    if (record.flushScheduled) return
    record.flushScheduled = true
    const schedule = this.dependencies.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
    schedule(() => this.flush(record), FLUSH_DELAY_MS)
  }

  private flush(record: TerminalRecord): void {
    record.flushScheduled = false
    if (!record.pending) return
    const chunk = record.pending
    record.pending = ''
    this.dependencies.onData(record.info.terminalId, chunk)
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId)
    if (!record) throw new Error('Terminal introuvable.')
    return record
  }

  /** Output produced so far (bounded), so a reloaded window can redraw its terminals. */
  scrollback(terminalId: string): string {
    return this.require(terminalId).scrollback
  }

  write(terminalId: string, data: string): void {
    const record = this.require(terminalId)
    if (!record.info.exited) record.process.write(data)
  }

  resize(terminalId: string, columns: number, rows: number): void {
    const record = this.require(terminalId)
    if (record.info.exited) return
    try {
      record.process.resize(columns, rows)
    } catch {
      // the pseudo-console may already be closing
    }
  }

  close(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (!record) return
    this.terminals.delete(terminalId)
    if (!record.info.exited) {
      try {
        record.process.kill()
      } catch {
        // already gone
      }
    }
  }

  closeAll(): void {
    for (const terminalId of [...this.terminals.keys()]) this.close(terminalId)
  }
}
