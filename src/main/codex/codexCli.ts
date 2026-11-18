/**
 * The official Codex CLI (OpenAI), signed in with the user's ChatGPT account (`codex login`).
 * Aether only runs `codex --version`, `codex login status` and `codex exec` in a read-only sandbox;
 * it never reads Codex's credentials.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodexStatus } from '../../shared/pilot'

import type { CommandRunner } from '../engine/claudeLocator'

export interface CodexLaunch {
  /** Program to start. */
  command: string
  /** Arguments placed before Codex's own (a script path for the test double). */
  prefixArgs: string[]
  source: CodexStatus['source']
}

const NPM_NATIVE_SUFFIX = ['node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe']

/** The npm shim (`codex.cmd`) wraps Node; the native binary beside it is started directly (no shell). */
export function nativeBinaryForShim(shimPath: string): string | null {
  const binDirectory = dirname(shimPath)
  const candidates = [join(binDirectory, ...NPM_NATIVE_SUFFIX), join(binDirectory, 'node_modules', '@openai', 'codex', ...NPM_NATIVE_SUFFIX)]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Newest `codex.exe` shipped with the Codex desktop app. */
export function codexAppBinary(localAppData: string | undefined): string | null {
  if (!localAppData) return null
  const root = join(localAppData, 'OpenAI', 'Codex', 'bin')
  try {
    const binaries = readdirSync(root)
      .map((entry) => join(root, entry, 'codex.exe'))
      .filter((path) => existsSync(path))
      .map((path) => ({ path, modified: statSync(path).mtimeMs }))
      .sort((left, right) => right.modified - left.modified)
    return binaries[0]?.path ?? null
  } catch {
    return null
  }
}

/**
 * Where Codex is, in order: the test double (environment), `codex` on the PATH (npm install),
 * the npm global folder, the Codex desktop app's bundled CLI.
 */
export async function locateCodex(run: CommandRunner, environment: NodeJS.ProcessEnv = process.env): Promise<CodexLaunch | null> {
  const override = environment.AETHER_CODEX_COMMAND
  if (override) {
    try {
      const parsed = JSON.parse(override) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === 'string')) return { command: parsed[0] as string, prefixArgs: parsed.slice(1) as string[], source: 'environment' }
    } catch {
      // ignored: falls back to the normal search
    }
  }
  if (process.platform === 'win32') {
    const found = await run('where.exe', ['codex'], 8000).catch(() => null)
    const paths = (found?.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const path of paths) {
      if (/\.exe$/i.test(path)) return { command: path, prefixArgs: [], source: 'path' }
      if (/\.(cmd|ps1)$/i.test(path) || !/\.[a-z0-9]+$/i.test(path)) {
        const native = nativeBinaryForShim(path)
        if (native) return { command: native, prefixArgs: [], source: 'path' }
      }
    }
    const npmGlobal = environment.APPDATA ? join(environment.APPDATA, 'npm', 'codex.cmd') : null
    const npmNative = npmGlobal ? nativeBinaryForShim(npmGlobal) : null
    if (npmNative) return { command: npmNative, prefixArgs: [], source: 'npm' }
    const appBinary = codexAppBinary(environment.LOCALAPPDATA)
    if (appBinary) return { command: appBinary, prefixArgs: [], source: 'codex-app' }
    return null
  }
  const found = await run('which', ['codex'], 8000).catch(() => null)
  const path = found?.stdout.trim().split(/\r?\n/)[0]
  return path ? { command: path, prefixArgs: [], source: 'path' } : null
}

export async function readCodexStatus(run: CommandRunner, environment: NodeJS.ProcessEnv = process.env): Promise<CodexStatus> {
  const launch = await locateCodex(run, environment)
  if (!launch) return { found: false, executablePath: null, version: null, source: 'none', loggedIn: false, loginDetail: null, error: null }
  try {
    const version = await run(launch.command, [...launch.prefixArgs, '--version'], 15_000)
    const login = await run(launch.command, [...launch.prefixArgs, 'login', 'status'], 15_000)
    const detail = `${login.stdout}\n${login.stderr}`.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null
    const loggedIn = login.exitCode === 0 && /logged in/i.test(`${login.stdout}${login.stderr}`)
    return { found: true, executablePath: launch.command, version: version.stdout.trim().replace(/^codex-cli\s*/i, '') || null, source: launch.source, loggedIn, loginDetail: detail, error: null }
  } catch (error) {
    return { found: true, executablePath: launch.command, version: null, source: launch.source, loggedIn: false, loginDetail: null, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// User settings carried over (the rest of ~/.codex/config.toml is ignored on purpose)
// ---------------------------------------------------------------------------

export interface CodexCarriedSettings {
  model: string | null
  reasoningEffort: string | null
  /** Windows sandbox flavour the user set up ("elevated" needs a one-time admin setup). */
  windowsSandbox: 'elevated' | 'unelevated'
}

const SAFE_VALUE = /^[A-Za-z0-9._-]{1,80}$/

/**
 * Reads three keys of Codex's config. The user's config is otherwise not loaded
 * (`--ignore-user-config`): its MCP servers and plugins could act outside the read-only sandbox.
 */
export function parseCodexSettings(toml: string): CodexCarriedSettings {
  let section = ''
  const settings: CodexCarriedSettings = { model: null, reasoningEffort: null, windowsSandbox: 'unelevated' }
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section = header[1]?.trim() ?? ''
      continue
    }
    const entry = /^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']\s*(#.*)?$/.exec(line)
    if (!entry) continue
    const [, key, value] = entry
    if (!value || !SAFE_VALUE.test(value)) continue
    if (section === '' && key === 'model') settings.model = value
    else if (section === '' && key === 'model_reasoning_effort') settings.reasoningEffort = value
    else if (section === 'windows' && key === 'sandbox' && (value === 'elevated' || value === 'unelevated')) settings.windowsSandbox = value
  }
  return settings
}

export function readCodexSettings(environment: NodeJS.ProcessEnv = process.env): CodexCarriedSettings {
  const codexHome = environment.CODEX_HOME ?? join(homedir(), '.codex')
  try {
    return parseCodexSettings(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
  } catch {
    return { model: null, reasoningEffort: null, windowsSandbox: 'unelevated' }
  }
}

// ---------------------------------------------------------------------------
// One `codex exec` turn
// ---------------------------------------------------------------------------

export interface CodexTurnRequest {
  launch: CodexLaunch
  workingDirectory: string
  prompt: string
  /** Resumes GPT's thread (keeps its memory); null starts a new one. */
  threadId: string | null
  schemaPath: string
  settings: CodexCarriedSettings
  timeoutMs: number
  /** The working folder is not a git repository (Codex refuses those by default). */
  skipGitCheck: boolean
}

export interface CodexTurnResult {
  threadId: string | null
  finalMessage: string | null
  inputTokens: number
  outputTokens: number
  /** Failure reported by Codex (or the process), null on success. */
  error: string | null
  /** Short activity lines (commands GPT ran to read the project). */
  activity: string[]
}

/** Arguments of `codex exec`: read-only sandbox, never asks for approval, JSON events, the decision schema. */
export function codexExecArguments(request: Pick<CodexTurnRequest, 'threadId' | 'schemaPath' | 'settings' | 'skipGitCheck' | 'workingDirectory'>): string[] {
  const common = ['--json', '--ignore-user-config', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', `windows.sandbox="${request.settings.windowsSandbox}"`, '--output-schema', request.schemaPath]
  if (request.settings.model) common.push('-m', request.settings.model)
  if (request.settings.reasoningEffort) common.push('-c', `model_reasoning_effort="${request.settings.reasoningEffort}"`)
  if (request.skipGitCheck) common.push('--skip-git-repo-check')
  // The prompt is read from stdin ("-"), never placed on the command line.
  if (request.threadId) return ['exec', 'resume', ...common, request.threadId, '-']
  return ['exec', ...common, '--cd', request.workingDirectory, '-']
}

interface CodexJsonEvent {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string; command?: string; status?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string } | string
  message?: string
}

/** Folds Codex's JSONL events into a turn result. Exported for tests. */
export function foldCodexEvents(lines: string[]): CodexTurnResult {
  const result: CodexTurnResult = { threadId: null, finalMessage: null, inputTokens: 0, outputTokens: 0, error: null, activity: [] }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: CodexJsonEvent
    try {
      event = JSON.parse(trimmed) as CodexJsonEvent
    } catch {
      continue
    }
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') result.threadId = event.thread_id
        break
      case 'item.completed':
        if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') result.finalMessage = event.item.text
        else if (event.item?.type === 'command_execution' && typeof event.item.command === 'string') result.activity.push(event.item.command.slice(0, 300))
        break
      case 'turn.completed':
        result.inputTokens += event.usage?.input_tokens ?? 0
        result.outputTokens += event.usage?.output_tokens ?? 0
        break
      case 'turn.failed':
      case 'error': {
        const message = typeof event.error === 'string' ? event.error : (event.error?.message ?? event.message ?? 'Erreur Codex')
        result.error = message.slice(0, 2000)
        break
      }
      default:
        break
    }
  }
  return result
}

export interface RunningCodexTurn {
  done: Promise<CodexTurnResult>
  cancel: () => void
}

export function startCodexTurn(request: CodexTurnRequest): RunningCodexTurn {
  const args = [...request.launch.prefixArgs, ...codexExecArguments(request)]
  let child: ChildProcess
  try {
    child = spawn(request.launch.command, args, { cwd: request.workingDirectory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
  } catch (error) {
    return { done: Promise.resolve({ threadId: null, finalMessage: null, inputTokens: 0, outputTokens: 0, error: `Codex n’a pas pu démarrer : ${error instanceof Error ? error.message : String(error)}`, activity: [] }), cancel: () => undefined }
  }
  let cancelled = false
  const done = new Promise<CodexTurnResult>((resolve) => {
    const lines: string[] = []
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stderr += `\nDélai dépassé (${Math.round(request.timeoutMs / 60000)} min).`
      killTree(child)
    }, request.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    const finish = (exitCode: number | null, spawnError?: Error): void => {
      clearTimeout(timer)
      if (buffer) lines.push(buffer)
      const result = foldCodexEvents(lines)
      if (cancelled) result.error = 'Arrêté par l’utilisateur.'
      else if (spawnError) result.error = (spawnError as NodeJS.ErrnoException).code === 'ENOENT' ? 'Codex est introuvable (réinstallez-le ou liez-le à nouveau).' : spawnError.message
      else if (!result.error && exitCode !== 0) result.error = lastErrorLine(stderr) ?? `Codex s’est arrêté (code ${exitCode ?? '?'}).`
      else if (!result.error && !result.finalMessage) result.error = lastErrorLine(stderr) ?? 'Codex n’a rendu aucune réponse.'
      resolve(result)
    }
    child.once('error', (error) => finish(null, error))
    child.once('close', (exitCode) => finish(exitCode))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(request.prompt, 'utf8')
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      killTree(child)
    }
  }
}

function lastErrorLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Reading (additional )?(input|prompt) from stdin/i.test(line))
  const errorLine = [...lines].reverse().find((line) => /error|erreur|limit|failed|denied/i.test(line))
  return (errorLine ?? lines.at(-1) ?? null)?.slice(0, 1000) ?? null
}

/** Ends a process and its children (Codex starts sandboxed helpers). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  } else {
    child.kill('SIGTERM')
  }
}
